begin;

-- Security Advisor follow-up:
-- move announcement and feature-flag RPCs to SECURITY INVOKER and protect
-- their tables through explicit RLS policies.  Functions that mutate quotas,
-- accept invitations, or are used as RLS helpers remain SECURITY DEFINER.

alter table public.app_announcements enable row level security;
alter table public.app_announcement_reads enable row level security;
alter table public.app_feature_flags enable row level security;

revoke all on public.app_announcements from anon, authenticated;
revoke all on public.app_announcement_reads from anon, authenticated;
revoke all on public.app_feature_flags from anon, authenticated;

grant select, insert, update, delete on public.app_announcements to authenticated;
grant select, insert, update on public.app_announcement_reads to authenticated;
grant select, update on public.app_feature_flags to authenticated;

drop policy if exists app_announcements_read_published on public.app_announcements;
create policy app_announcements_read_published
on public.app_announcements
for select
to authenticated
using (is_published);

drop policy if exists app_announcements_admin_manage on public.app_announcements;
create policy app_announcements_admin_manage
on public.app_announcements
for all
to authenticated
using ((select public.is_app_admin((select auth.uid()))))
with check ((select public.is_app_admin((select auth.uid()))));

drop policy if exists app_announcement_reads_select_own on public.app_announcement_reads;
create policy app_announcement_reads_select_own
on public.app_announcement_reads
for select
to authenticated
using (user_id = (select auth.uid()));

drop policy if exists app_announcement_reads_insert_own on public.app_announcement_reads;
create policy app_announcement_reads_insert_own
on public.app_announcement_reads
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.app_announcements announcement
    where announcement.id = app_announcement_reads.announcement_id
      and announcement.is_published
  )
);

drop policy if exists app_announcement_reads_update_own on public.app_announcement_reads;
create policy app_announcement_reads_update_own
on public.app_announcement_reads
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists app_feature_flags_read_authenticated on public.app_feature_flags;
create policy app_feature_flags_read_authenticated
on public.app_feature_flags
for select
to authenticated
using (true);

drop policy if exists app_feature_flags_admin_update on public.app_feature_flags;
create policy app_feature_flags_admin_update
on public.app_feature_flags
for update
to authenticated
using ((select public.is_app_admin((select auth.uid()))))
with check ((select public.is_app_admin((select auth.uid()))));

create or replace function public.get_app_feature_flags()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_object_agg(key, is_enabled), '{}'::jsonb)
  from public.app_feature_flags;
$$;

create or replace function public.admin_list_feature_flags()
returns table (
  key text,
  title text,
  description text,
  is_enabled boolean,
  updated_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    flag.key,
    flag.title,
    flag.description,
    flag.is_enabled,
    flag.updated_at
  from public.app_feature_flags flag
  order by flag.title;
end;
$$;

create or replace function public.admin_set_feature_flag(
  target_key text,
  target_is_enabled boolean
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  update public.app_feature_flags
  set
    is_enabled = target_is_enabled,
    updated_by = auth.uid(),
    updated_at = now()
  where key = target_key;

  if not found then
    raise exception 'UNKNOWN_FEATURE_FLAG:%', target_key using errcode = 'P0002';
  end if;
end;
$$;

create or replace function public.list_my_app_announcements()
returns table (
  id uuid,
  title text,
  body text,
  category text,
  media_type text,
  media_url text,
  cta_label text,
  cta_url text,
  is_published boolean,
  published_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_read boolean,
  read_at timestamptz,
  email_status text,
  email_requested_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    announcement.id,
    announcement.title,
    announcement.body,
    announcement.category,
    announcement.media_type,
    announcement.media_url,
    announcement.cta_label,
    announcement.cta_url,
    announcement.is_published,
    announcement.published_at,
    announcement.created_at,
    announcement.updated_at,
    read_row.read_at is not null as is_read,
    read_row.read_at,
    announcement.email_status,
    announcement.email_requested_at
  from public.app_announcements announcement
  left join public.app_announcement_reads read_row
    on read_row.announcement_id = announcement.id
   and read_row.user_id = auth.uid()
  where announcement.is_published
  order by coalesce(announcement.published_at, announcement.created_at) desc;
end;
$$;

create or replace function public.mark_app_announcement_read(target_announcement_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.app_announcements announcement
    where announcement.id = target_announcement_id
      and announcement.is_published
  ) then
    raise exception 'ANNOUNCEMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.app_announcement_reads (announcement_id, user_id, read_at)
  values (target_announcement_id, auth.uid(), now())
  on conflict (announcement_id, user_id)
  do update set read_at = excluded.read_at;
end;
$$;

create or replace function public.admin_list_app_announcements()
returns table (
  id uuid,
  title text,
  body text,
  category text,
  media_type text,
  media_url text,
  cta_label text,
  cta_url text,
  is_published boolean,
  published_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  is_read boolean,
  read_at timestamptz,
  email_status text,
  email_requested_at timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    announcement.id,
    announcement.title,
    announcement.body,
    announcement.category,
    announcement.media_type,
    announcement.media_url,
    announcement.cta_label,
    announcement.cta_url,
    announcement.is_published,
    announcement.published_at,
    announcement.created_at,
    announcement.updated_at,
    false as is_read,
    null::timestamptz as read_at,
    announcement.email_status,
    announcement.email_requested_at
  from public.app_announcements announcement
  order by announcement.created_at desc;
end;
$$;

create or replace function public.admin_upsert_app_announcement(
  target_id uuid default null,
  target_title text default null,
  target_body text default null,
  target_category text default 'update',
  target_media_type text default 'none',
  target_media_url text default null,
  target_cta_label text default null,
  target_cta_url text default null,
  target_is_published boolean default false,
  target_email_status text default 'not_planned'
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  next_id uuid;
  normalized_title text := btrim(coalesce(target_title, ''));
  normalized_body text := btrim(coalesce(target_body, ''));
  normalized_media_type text := coalesce(nullif(btrim(target_media_type), ''), 'none');
  normalized_email_status text := coalesce(nullif(btrim(target_email_status), ''), 'not_planned');
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  if normalized_title = '' then
    raise exception 'ANNOUNCEMENT_TITLE_REQUIRED' using errcode = '23514';
  end if;

  if normalized_body = '' then
    raise exception 'ANNOUNCEMENT_BODY_REQUIRED' using errcode = '23514';
  end if;

  if target_category not in ('update', 'feature', 'maintenance', 'tip') then
    raise exception 'INVALID_ANNOUNCEMENT_CATEGORY' using errcode = '23514';
  end if;

  if normalized_media_type not in ('none', 'image', 'video', 'link') then
    raise exception 'INVALID_ANNOUNCEMENT_MEDIA_TYPE' using errcode = '23514';
  end if;

  if normalized_email_status not in ('not_planned', 'planned', 'sent') then
    raise exception 'INVALID_ANNOUNCEMENT_EMAIL_STATUS' using errcode = '23514';
  end if;

  if target_id is null then
    insert into public.app_announcements (
      title,
      body,
      category,
      media_type,
      media_url,
      cta_label,
      cta_url,
      is_published,
      published_at,
      email_status,
      email_requested_at,
      email_requested_by,
      created_by,
      updated_by
    )
    values (
      normalized_title,
      normalized_body,
      target_category,
      normalized_media_type,
      nullif(btrim(coalesce(target_media_url, '')), ''),
      nullif(btrim(coalesce(target_cta_label, '')), ''),
      nullif(btrim(coalesce(target_cta_url, '')), ''),
      target_is_published,
      case when target_is_published then now() else null end,
      normalized_email_status,
      case when normalized_email_status = 'planned' then now() else null end,
      case when normalized_email_status = 'planned' then auth.uid() else null end,
      auth.uid(),
      auth.uid()
    )
    returning id into next_id;
  else
    update public.app_announcements
    set
      title = normalized_title,
      body = normalized_body,
      category = target_category,
      media_type = normalized_media_type,
      media_url = nullif(btrim(coalesce(target_media_url, '')), ''),
      cta_label = nullif(btrim(coalesce(target_cta_label, '')), ''),
      cta_url = nullif(btrim(coalesce(target_cta_url, '')), ''),
      is_published = target_is_published,
      published_at = case
        when target_is_published and published_at is null then now()
        when not target_is_published then null
        else published_at
      end,
      email_status = normalized_email_status,
      email_requested_at = case
        when normalized_email_status = 'planned' and email_requested_at is null then now()
        when normalized_email_status <> 'planned' then null
        else email_requested_at
      end,
      email_requested_by = case
        when normalized_email_status = 'planned' then coalesce(email_requested_by, auth.uid())
        else null
      end,
      updated_by = auth.uid()
    where id = target_id
    returning id into next_id;

    if next_id is null then
      raise exception 'ANNOUNCEMENT_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  return next_id;
end;
$$;

create or replace function public.admin_delete_app_announcement(target_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'APP_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  delete from public.app_announcements
  where id = target_id;
end;
$$;

create or replace function public.begin_hypothesis_ai_review(target_project_id uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
begin
  return public.begin_ai_credit_usage(
    target_project_id,
    'hypothesis_review',
    1,
    0,
    0,
    null,
    jsonb_build_object('legacy_limit_key', 'hypothesis_ai_reviews_per_month')
  );
end;
$$;

revoke execute on function public.get_app_feature_flags() from public, anon;
revoke execute on function public.admin_list_feature_flags() from public, anon;
revoke execute on function public.admin_set_feature_flag(text, boolean) from public, anon;
revoke execute on function public.list_my_app_announcements() from public, anon;
revoke execute on function public.mark_app_announcement_read(uuid) from public, anon;
revoke execute on function public.admin_list_app_announcements() from public, anon;
revoke execute on function public.admin_upsert_app_announcement(uuid, text, text, text, text, text, text, text, boolean, text) from public, anon;
revoke execute on function public.admin_delete_app_announcement(uuid) from public, anon;
revoke execute on function public.begin_hypothesis_ai_review(uuid) from public, anon;

grant execute on function public.get_app_feature_flags() to authenticated;
grant execute on function public.admin_list_feature_flags() to authenticated;
grant execute on function public.admin_set_feature_flag(text, boolean) to authenticated;
grant execute on function public.list_my_app_announcements() to authenticated;
grant execute on function public.mark_app_announcement_read(uuid) to authenticated;
grant execute on function public.admin_list_app_announcements() to authenticated;
grant execute on function public.admin_upsert_app_announcement(uuid, text, text, text, text, text, text, text, boolean, text) to authenticated;
grant execute on function public.admin_delete_app_announcement(uuid) to authenticated;
grant execute on function public.begin_hypothesis_ai_review(uuid) to authenticated;

commit;
