begin;
set local lock_timeout = '5s';

-- Historical details can contain names copied before a person became private.
-- Keep the original audit history for editors; never expose it to viewers.
alter policy activity_log_select_members on public.activity_log using (
  project_id in (select pm.project_id from public.project_members pm
    where pm.user_id = (select auth.uid()) and pm.role in ('owner', 'editor'))
);

create function security_private.list_project_activity_v1(target_project_id uuid, max_rows integer default 100)
returns table(id bigint, action text, entity_type text, entity_id uuid, details jsonb, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare editor boolean;
begin
  if not public.is_project_member(target_project_id) then
    raise exception 'PROJECT_ACCESS_DENIED' using errcode = '42501';
  end if;
  editor := public.can_edit_project(target_project_id);
  return query
  select a.id,
    case when editor then a.action else 'record_updated' end,
    case when editor then a.entity_type else 'settings' end,
    case when editor then a.entity_id else null::uuid end,
    case when editor then a.details else jsonb_build_object('text', 'Оновлено дані проєкту', 'module', 'settings') end,
    a.created_at
  from public.activity_log a
  where a.project_id = target_project_id
    -- Fail closed for missing/deleted/ambiguous person references. Other legacy
    -- text is also projected generically: a title can mention a private person.
    and (editor or (a.entity_type <> 'persons' and coalesce(a.details->>'module', '') <> 'persons')
      or exists (select 1 from public.persons p where p.project_id = a.project_id
        and p.id = a.entity_id and not (p.is_living and p.privacy_status in ('private', 'confidential'))))
  order by a.created_at desc, a.id desc limit greatest(1, least(coalesce(max_rows, 100), 500));
end $$;
revoke all on function security_private.list_project_activity_v1(uuid, integer) from public, anon, authenticated, service_role;
grant execute on function security_private.list_project_activity_v1(uuid, integer) to authenticated;
create function public.list_project_activity_v1(target_project_id uuid, max_rows integer default 100)
returns table(id bigint, action text, entity_type text, entity_id uuid, details jsonb, created_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select * from security_private.list_project_activity_v1(target_project_id, max_rows);
$$;
revoke all on function public.list_project_activity_v1(uuid, integer) from public, anon, service_role;
grant execute on function public.list_project_activity_v1(uuid, integer) to authenticated;

-- Realtime is an invalidation signal, not an alternate data-delivery API.
create table public.project_change_events (
  id bigint primary key references public.activity_log(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid,
  entity_type text not null,
  entity_id uuid,
  action text not null,
  created_at timestamptz not null default now()
);
create index project_change_events_project_created_idx on public.project_change_events(project_id, created_at);
alter table public.project_change_events enable row level security;
revoke all on public.project_change_events from public, anon, authenticated;
grant select on public.project_change_events to authenticated;
create policy project_change_events_select on public.project_change_events for select to authenticated using (
  project_id in (select pm.project_id from public.project_members pm where pm.user_id = (select auth.uid()))
);
create function security_private.emit_project_change_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare module_key text; mutation_id text; safe_action text;
begin
  module_key := coalesce(new.details->>'module', new.entity_type);
  if module_key not in ('researches', 'persons', 'documents', 'yearMatrix', 'tasks', 'findings', 'hypotheses', 'archiveRequests', 'settings')
    and module_key !~ '^custom:[0-9a-fA-F-]{36}$' then module_key := 'settings'; end if;
  mutation_id := coalesce(new.details->>'entityId', new.entity_id::text);
  if mutation_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then mutation_id := null; end if;
  safe_action := case
    when new.action in ('record_deleted', 'relation_created', 'relation_updated', 'relation_deleted') then new.action
    when new.action like 'field_%' or new.action like 'section_%' then 'section_updated'
    else 'record_updated' end;
  insert into public.project_change_events(id, project_id, actor_id, entity_type, entity_id, action)
    values(new.id, new.project_id, new.actor_id, module_key, mutation_id::uuid, safe_action);
  return new;
end $$;
revoke all on function security_private.emit_project_change_event() from public, anon, authenticated, service_role;
create trigger activity_log_emit_safe_change after insert on public.activity_log
  for each row execute function security_private.emit_project_change_event();

-- No backfill: clients refetch the protected state after subscribing.
do $$ begin
  if exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    if exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='activity_log') then
      alter publication supabase_realtime drop table public.activity_log;
    end if;
    alter publication supabase_realtime add table public.project_change_events;
  end if;
end $$;
commit;
