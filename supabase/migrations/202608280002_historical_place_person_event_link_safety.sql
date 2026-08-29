begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- Historical places are additive. Existing place_name/geo values remain the
-- compatibility representation for older clients and exports.
alter table public.person_timeline_events
  add column if not exists place_id uuid
    references public.places(id) on delete restrict,
  add column if not exists place_original_text text not null default '',
  add column if not exists place_resolution_status text not null default 'unresolved';

alter table public.person_timeline_events
  drop constraint if exists person_timeline_events_place_resolution_status_check;
alter table public.person_timeline_events
  add constraint person_timeline_events_place_resolution_status_check
  check (place_resolution_status = any (array[
    'unresolved', 'confirmed', 'needs_review'
  ]::text[]));

alter table public.person_timeline_events
  drop constraint if exists person_timeline_events_confirmed_place_check;
alter table public.person_timeline_events
  add constraint person_timeline_events_confirmed_place_check
  check (place_resolution_status <> 'confirmed' or place_id is not null);

comment on column public.person_timeline_events.place_id is
  'Optional confirmed historical-place identity. The legacy place_name remains unchanged for compatibility.';
comment on column public.person_timeline_events.place_original_text is
  'Exact place wording supplied by the user or source. It is never replaced by the canonical Place name.';
comment on column public.person_timeline_events.place_resolution_status is
  'Whether the optional place identity is unresolved, confirmed, or needs another review.';

create index if not exists person_timeline_events_place_id_idx
  on public.person_timeline_events (place_id)
  where place_id is not null;

-- family_tree_sync_person_projection currently rebuilds legacy projection
-- events with DELETE + INSERT. This private transaction context is declared
-- before the validation trigger because an exact pre-existing link may need
-- to survive a later catalogue merge or archive without becoming selectable
-- for a new event.
create table if not exists security_private.person_event_place_restore_context (
  transaction_id bigint not null,
  backend_pid integer not null,
  project_id uuid not null,
  person_id uuid not null,
  event_type text not null,
  place_id uuid,
  place_original_text text not null default '',
  place_name_snapshot text not null default '',
  place_resolution_status text not null default 'unresolved',
  is_ambiguous boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (transaction_id, backend_pid, project_id, person_id, event_type)
);

revoke all on table security_private.person_event_place_restore_context
  from public, anon, authenticated, service_role;

-- A project event may use its own private Place or a shared/global Place, but
-- it must never point into another project's private catalogue. Keep the
-- source wording verbatim; canonical names are display metadata, not a
-- replacement for what the document or user actually said.
create or replace function security_private.validate_person_event_place_link_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  linked_place_project_id uuid;
  linked_place_status text;
  linked_place_verification_status text;
  projection_restore_allowed boolean := false;
begin
  if btrim(coalesce(new.place_original_text, '')) = ''
     and coalesce(new.place_name, '') <> '' then
    new.place_original_text := new.place_name;
  end if;

  if new.place_id is null then
    return new;
  end if;

  select
    place_row.project_id,
    place_row.status,
    place_row.verification_status
  into
    linked_place_project_id,
    linked_place_status,
    linked_place_verification_status
  from public.places place_row
  where place_row.id = new.place_id;

  if not found then
    raise exception 'PERSON_EVENT_PLACE_NOT_FOUND'
      using errcode = '23503';
  end if;

  if linked_place_project_id is not null
     and linked_place_project_id is distinct from new.project_id then
    raise exception 'PERSON_EVENT_PLACE_SCOPE_MISMATCH'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE'
     and coalesce(new.metadata ->> 'source', '') like 'persons_projection%' then
    select exists (
      select 1
      from security_private.person_event_place_restore_context context
      where context.transaction_id = pg_catalog.txid_current()
        and context.backend_pid = pg_catalog.pg_backend_pid()
        and context.project_id = new.project_id
        and context.person_id = new.person_id
        and context.event_type = new.event_type
        and not context.is_ambiguous
        and context.place_id = new.place_id
        and context.place_name_snapshot is not distinct from coalesce(new.place_name, '')
    ) into projection_restore_allowed;
  end if;

  if linked_place_project_id is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not projection_restore_allowed
     and not (
       linked_place_status = 'active'
       and linked_place_verification_status = 'verified'
     ) then
    raise exception 'PERSON_EVENT_PLACE_ACCESS_REQUIRED'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

drop trigger if exists person_timeline_events_02_validate_place_link
  on public.person_timeline_events;
create trigger person_timeline_events_02_validate_place_link
before insert or update of
  place_id,
  project_id,
  place_name,
  place_original_text,
  place_resolution_status
on public.person_timeline_events
for each row execute function
  security_private.validate_person_event_place_link_v1();

create or replace function security_private.capture_person_event_place_before_projection_delete_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  if coalesce(old.metadata ->> 'source', '') not like 'persons_projection%'
    or (
      old.place_id is null
      and coalesce(old.place_original_text, '') = ''
    ) then
    return old;
  end if;

  insert into security_private.person_event_place_restore_context (
    transaction_id,
    backend_pid,
    project_id,
    person_id,
    event_type,
    place_id,
    place_original_text,
    place_name_snapshot,
    place_resolution_status
  ) values (
    pg_catalog.txid_current(),
    pg_catalog.pg_backend_pid(),
    old.project_id,
    old.person_id,
    old.event_type,
    old.place_id,
    coalesce(nullif(old.place_original_text, ''), old.place_name, ''),
    coalesce(old.place_name, ''),
    old.place_resolution_status
  )
  on conflict (transaction_id, backend_pid, project_id, person_id, event_type)
  do update set
    place_id = null,
    is_ambiguous = true;

  return old;
end;
$function$;

create or replace function security_private.restore_person_event_place_after_projection_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  saved_link security_private.person_event_place_restore_context%rowtype;
begin
  if coalesce(new.metadata ->> 'source', '') not like 'persons_projection%' then
    return new;
  end if;

  select context.*
  into saved_link
  from security_private.person_event_place_restore_context context
  where context.transaction_id = pg_catalog.txid_current()
    and context.backend_pid = pg_catalog.pg_backend_pid()
    and context.project_id = new.project_id
    and context.person_id = new.person_id
    and context.event_type = new.event_type;

  if not found
    or saved_link.is_ambiguous
    or saved_link.place_name_snapshot is distinct from coalesce(new.place_name, '') then
    return new;
  end if;

  update public.person_timeline_events event_row
  set
    place_id = saved_link.place_id,
    place_original_text = saved_link.place_original_text,
    place_resolution_status = saved_link.place_resolution_status
  where event_row.id = new.id;

  delete from security_private.person_event_place_restore_context context
  where context.transaction_id = saved_link.transaction_id
    and context.backend_pid = saved_link.backend_pid
    and context.project_id = saved_link.project_id
    and context.person_id = saved_link.person_id
    and context.event_type = saved_link.event_type;

  return new;
end;
$function$;

create or replace function security_private.cleanup_person_event_place_restore_context_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  delete from security_private.person_event_place_restore_context context
  where context.transaction_id = pg_catalog.txid_current()
    and context.backend_pid = pg_catalog.pg_backend_pid();
  return old;
end;
$function$;

drop trigger if exists person_timeline_events_05_capture_place_before_projection_delete
  on public.person_timeline_events;
create trigger person_timeline_events_05_capture_place_before_projection_delete
before delete on public.person_timeline_events
for each row execute function
  security_private.capture_person_event_place_before_projection_delete_v1();

drop trigger if exists person_timeline_events_12_historical_place_lock
  on public.person_timeline_events;
create trigger person_timeline_events_12_historical_place_lock
before insert or update or delete on public.person_timeline_events
for each row execute function
  security_private.lock_historical_place_child_write_v1();

drop trigger if exists person_timeline_events_15_restore_place_after_projection_insert
  on public.person_timeline_events;
create trigger person_timeline_events_15_restore_place_after_projection_insert
after insert on public.person_timeline_events
for each row execute function
  security_private.restore_person_event_place_after_projection_insert_v1();

drop trigger if exists person_timeline_events_95_cleanup_place_restore_context
  on public.person_timeline_events;
create constraint trigger person_timeline_events_95_cleanup_place_restore_context
after delete on public.person_timeline_events
deferrable initially deferred
for each row execute function
  security_private.cleanup_person_event_place_restore_context_v1();

revoke all on function
  security_private.validate_person_event_place_link_v1(),
  security_private.capture_person_event_place_before_projection_delete_v1(),
  security_private.restore_person_event_place_after_projection_insert_v1(),
  security_private.cleanup_person_event_place_restore_context_v1()
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
