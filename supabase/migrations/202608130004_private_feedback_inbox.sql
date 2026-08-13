begin;

-- Asynchronous private support inbox. Threads are account-scoped rather than
-- project-scoped so a user keeps one support history while switching trees.
create table if not exists public.feedback_threads (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null default '',
  author_email text not null default '',
  subject text not null check (char_length(subject) between 3 and 160),
  category text not null default 'question'
    check (category in ('question', 'suggestion', 'problem', 'other')),
  status text not null default 'open'
    check (status in ('open', 'answered', 'closed')),
  last_message_at timestamptz not null default now(),
  last_message_role text not null default 'user'
    check (last_message_role in ('user', 'admin')),
  author_last_read_at timestamptz,
  admin_last_read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.feedback_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.feedback_threads(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_role text not null check (sender_role in ('user', 'admin')),
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);

create index if not exists feedback_threads_author_last_message_idx
  on public.feedback_threads (author_id, last_message_at desc);
create index if not exists feedback_threads_admin_last_message_idx
  on public.feedback_threads (last_message_at desc);
create index if not exists feedback_messages_thread_created_idx
  on public.feedback_messages (thread_id, created_at, id);

drop trigger if exists feedback_threads_set_updated_at on public.feedback_threads;
create trigger feedback_threads_set_updated_at
before update on public.feedback_threads
for each row execute function public.set_updated_at();

alter table public.feedback_threads enable row level security;
alter table public.feedback_messages enable row level security;

drop policy if exists feedback_threads_private_read on public.feedback_threads;
create policy feedback_threads_private_read
on public.feedback_threads for select to authenticated
using (
  author_id = (select auth.uid())
  or (select public.is_app_admin((select auth.uid())))
);

drop policy if exists feedback_messages_private_read on public.feedback_messages;
create policy feedback_messages_private_read
on public.feedback_messages for select to authenticated
using (
  exists (
    select 1
    from public.feedback_threads thread
    where thread.id = feedback_messages.thread_id
      and (
        thread.author_id = (select auth.uid())
        or (select public.is_app_admin((select auth.uid())))
      )
  )
);

-- Direct writes are intentionally unavailable. Controlled RPCs below derive
-- the sender and sender role from auth.uid(), and update unread state atomically.
revoke all on public.feedback_threads from public, anon, authenticated;
revoke all on public.feedback_messages from public, anon, authenticated;
grant select on public.feedback_threads to authenticated;
grant select on public.feedback_messages to authenticated;
grant select, insert, update, delete on public.feedback_threads to service_role;
grant select, insert, update, delete on public.feedback_messages to service_role;

create or replace function security_private.list_feedback_threads_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  current_is_admin boolean;
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  current_is_admin := public.is_app_admin(current_user_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', thread.id,
    'authorId', thread.author_id,
    'authorName', coalesce(nullif(profile.display_name, ''), nullif(thread.author_name, ''), 'Користувач'),
    'authorEmail', coalesce(nullif(profile.email, ''), thread.author_email),
    'subject', thread.subject,
    'category', thread.category,
    'status', thread.status,
    'lastMessageAt', thread.last_message_at,
    'lastMessageRole', thread.last_message_role,
    'createdAt', thread.created_at,
    'updatedAt', thread.updated_at,
    'messageCount', (select count(*) from public.feedback_messages message where message.thread_id = thread.id),
    'unread', case
      when current_is_admin then
        thread.last_message_role = 'user'
        and (thread.admin_last_read_at is null or thread.admin_last_read_at < thread.last_message_at)
      else
        thread.last_message_role = 'admin'
        and (thread.author_last_read_at is null or thread.author_last_read_at < thread.last_message_at)
    end
  ) order by thread.last_message_at desc, thread.id), '[]'::jsonb)
  into result
  from public.feedback_threads thread
  left join public.profiles profile on profile.user_id = thread.author_id
  where current_is_admin or thread.author_id = current_user_id;

  return result;
end;
$function$;

create or replace function security_private.list_feedback_messages_v1(
  p_thread_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  allowed boolean;
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select exists (
    select 1
    from public.feedback_threads thread
    where thread.id = p_thread_id
      and (thread.author_id = current_user_id or public.is_app_admin(current_user_id))
  ) into allowed;
  if not allowed then
    raise exception 'FEEDBACK_THREAD_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', message.id,
    'threadId', message.thread_id,
    'senderId', message.sender_id,
    'senderRole', message.sender_role,
    'body', message.body,
    'createdAt', message.created_at
  ) order by message.created_at, message.id), '[]'::jsonb)
  into result
  from public.feedback_messages message
  where message.thread_id = p_thread_id;

  return result;
end;
$function$;

create or replace function security_private.create_feedback_thread_v1(
  p_subject text,
  p_category text,
  p_body text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_subject text := btrim(coalesce(p_subject, ''));
  normalized_category text := lower(btrim(coalesce(p_category, 'question')));
  normalized_body text := btrim(coalesce(p_body, ''));
  current_name text;
  current_email text;
  next_thread_id uuid;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if char_length(normalized_subject) not between 3 and 160 then
    raise exception 'FEEDBACK_SUBJECT_LENGTH' using errcode = '23514';
  end if;
  if normalized_category not in ('question', 'suggestion', 'problem', 'other') then
    raise exception 'FEEDBACK_CATEGORY_INVALID' using errcode = '23514';
  end if;
  if char_length(normalized_body) not between 1 and 5000 then
    raise exception 'FEEDBACK_MESSAGE_LENGTH' using errcode = '23514';
  end if;
  if (
    select count(*)
    from public.feedback_threads thread
    where thread.author_id = current_user_id
      and thread.created_at > now() - interval '1 hour'
  ) >= 10 then
    raise exception 'FEEDBACK_THREAD_RATE_LIMIT' using errcode = '54000';
  end if;

  select
    coalesce(nullif(profile.display_name, ''), nullif(auth.jwt() -> 'user_metadata' ->> 'full_name', ''), 'Користувач'),
    coalesce(nullif(profile.email, ''), nullif(auth.jwt() ->> 'email', ''), '')
  into current_name, current_email
  from (select 1) seed
  left join public.profiles profile on profile.user_id = current_user_id;

  insert into public.feedback_threads (
    author_id, author_name, author_email, subject, category, status,
    last_message_at, last_message_role, author_last_read_at
  ) values (
    current_user_id, coalesce(current_name, 'Користувач'), coalesce(current_email, ''),
    normalized_subject, normalized_category, 'open', now(), 'user', now()
  ) returning id into next_thread_id;

  insert into public.feedback_messages (thread_id, sender_id, sender_role, body)
  values (next_thread_id, current_user_id, 'user', normalized_body);

  return next_thread_id;
end;
$function$;

create or replace function security_private.post_feedback_message_v1(
  p_thread_id uuid,
  p_body text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_body text := btrim(coalesce(p_body, ''));
  target_thread public.feedback_threads%rowtype;
  next_role text;
  next_message_id uuid;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if char_length(normalized_body) not between 1 and 5000 then
    raise exception 'FEEDBACK_MESSAGE_LENGTH' using errcode = '23514';
  end if;

  select * into target_thread
  from public.feedback_threads thread
  where thread.id = p_thread_id
  for update;
  if not found then
    raise exception 'FEEDBACK_THREAD_NOT_FOUND' using errcode = 'P0002';
  end if;

  if target_thread.author_id = current_user_id then
    next_role := 'user';
  elsif public.is_app_admin(current_user_id) then
    next_role := 'admin';
  else
    raise exception 'FEEDBACK_ACCESS_DENIED' using errcode = '42501';
  end if;

  if (
    select count(*)
    from public.feedback_messages message
    where message.sender_id = current_user_id
      and message.created_at > now() - interval '1 hour'
  ) >= 100 then
    raise exception 'FEEDBACK_MESSAGE_RATE_LIMIT' using errcode = '54000';
  end if;

  insert into public.feedback_messages (thread_id, sender_id, sender_role, body)
  values (p_thread_id, current_user_id, next_role, normalized_body)
  returning id into next_message_id;

  update public.feedback_threads
  set
    status = case when next_role = 'admin' then 'answered' else 'open' end,
    last_message_at = now(),
    last_message_role = next_role,
    author_last_read_at = case when next_role = 'user' then now() else author_last_read_at end,
    admin_last_read_at = case when next_role = 'admin' then now() else admin_last_read_at end
  where id = p_thread_id;

  return next_message_id;
end;
$function$;

create or replace function security_private.mark_feedback_thread_read_v1(
  p_thread_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  target_author_id uuid;
  current_is_admin boolean;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select thread.author_id into target_author_id
  from public.feedback_threads thread
  where thread.id = p_thread_id;
  if target_author_id is null then
    raise exception 'FEEDBACK_THREAD_NOT_FOUND' using errcode = 'P0002';
  end if;
  current_is_admin := public.is_app_admin(current_user_id);
  if target_author_id <> current_user_id and not current_is_admin then
    raise exception 'FEEDBACK_ACCESS_DENIED' using errcode = '42501';
  end if;

  update public.feedback_threads
  set
    author_last_read_at = case when target_author_id = current_user_id then now() else author_last_read_at end,
    admin_last_read_at = case when current_is_admin and target_author_id <> current_user_id then now() else admin_last_read_at end
  where id = p_thread_id;
end;
$function$;

create or replace function security_private.set_feedback_thread_status_v1(
  p_thread_id uuid,
  p_status text
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_status text := lower(btrim(coalesce(p_status, '')));
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if normalized_status not in ('open', 'closed') then
    raise exception 'FEEDBACK_STATUS_INVALID' using errcode = '23514';
  end if;

  update public.feedback_threads thread
  set status = normalized_status
  where thread.id = p_thread_id
    and (
      thread.author_id = current_user_id
      or public.is_app_admin(current_user_id)
    );
  if not found then
    raise exception 'FEEDBACK_THREAD_NOT_FOUND' using errcode = 'P0002';
  end if;
end;
$function$;

create or replace function security_private.get_feedback_unread_count_v1()
returns integer
language plpgsql
stable
security definer
set search_path = pg_catalog
as $function$
declare
  current_user_id uuid := auth.uid();
  current_is_admin boolean;
  result integer;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  current_is_admin := public.is_app_admin(current_user_id);

  select count(*)::integer into result
  from public.feedback_threads thread
  where case
    when current_is_admin then
      thread.last_message_role = 'user'
      and (thread.admin_last_read_at is null or thread.admin_last_read_at < thread.last_message_at)
    else
      thread.author_id = current_user_id
      and thread.last_message_role = 'admin'
      and (thread.author_last_read_at is null or thread.author_last_read_at < thread.last_message_at)
  end;
  return result;
end;
$function$;

-- Public API functions remain SECURITY INVOKER to keep Security Advisor clean.
create or replace function public.list_feedback_threads()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.list_feedback_threads_v1() $$;

create or replace function public.list_feedback_messages(p_thread_id uuid)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.list_feedback_messages_v1($1) $$;

create or replace function public.create_feedback_thread(p_subject text, p_category text, p_body text)
returns uuid language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.create_feedback_thread_v1($1, $2, $3) $$;

create or replace function public.post_feedback_message(p_thread_id uuid, p_body text)
returns uuid language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.post_feedback_message_v1($1, $2) $$;

create or replace function public.mark_feedback_thread_read(p_thread_id uuid)
returns void language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.mark_feedback_thread_read_v1($1) $$;

create or replace function public.set_feedback_thread_status(p_thread_id uuid, p_status text)
returns void language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.set_feedback_thread_status_v1($1, $2) $$;

create or replace function public.get_feedback_unread_count()
returns integer language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.get_feedback_unread_count_v1() $$;

revoke all on function security_private.list_feedback_threads_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.list_feedback_messages_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.create_feedback_thread_v1(text, text, text) from public, anon, authenticated, service_role;
revoke all on function security_private.post_feedback_message_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function security_private.mark_feedback_thread_read_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.set_feedback_thread_status_v1(uuid, text) from public, anon, authenticated, service_role;
revoke all on function security_private.get_feedback_unread_count_v1() from public, anon, authenticated, service_role;
grant execute on function security_private.list_feedback_threads_v1() to authenticated, service_role;
grant execute on function security_private.list_feedback_messages_v1(uuid) to authenticated, service_role;
grant execute on function security_private.create_feedback_thread_v1(text, text, text) to authenticated, service_role;
grant execute on function security_private.post_feedback_message_v1(uuid, text) to authenticated, service_role;
grant execute on function security_private.mark_feedback_thread_read_v1(uuid) to authenticated, service_role;
grant execute on function security_private.set_feedback_thread_status_v1(uuid, text) to authenticated, service_role;
grant execute on function security_private.get_feedback_unread_count_v1() to authenticated, service_role;

revoke all on function public.list_feedback_threads() from public, anon, authenticated, service_role;
revoke all on function public.list_feedback_messages(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_feedback_thread(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.post_feedback_message(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.mark_feedback_thread_read(uuid) from public, anon, authenticated, service_role;
revoke all on function public.set_feedback_thread_status(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.get_feedback_unread_count() from public, anon, authenticated, service_role;
grant execute on function public.list_feedback_threads() to authenticated, service_role;
grant execute on function public.list_feedback_messages(uuid) to authenticated, service_role;
grant execute on function public.create_feedback_thread(text, text, text) to authenticated, service_role;
grant execute on function public.post_feedback_message(uuid, text) to authenticated, service_role;
grant execute on function public.mark_feedback_thread_read(uuid) to authenticated, service_role;
grant execute on function public.set_feedback_thread_status(uuid, text) to authenticated, service_role;
grant execute on function public.get_feedback_unread_count() to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
