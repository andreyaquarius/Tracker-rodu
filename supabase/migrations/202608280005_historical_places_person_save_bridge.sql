begin;

set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- The browser has supported these event types for a long time. The canonical
-- timeline projection must accept the same additive vocabulary before custom
-- events can be mirrored safely.
alter table public.person_timeline_events
  drop constraint if exists person_timeline_events_event_type_check;
alter table public.person_timeline_events
  add constraint person_timeline_events_event_type_check
  check (event_type in (
    'birth', 'baptism', 'christening', 'marriage', 'divorce', 'residence',
    'census', 'revision_list', 'confession_list', 'household_register',
    'immigration', 'emigration', 'military', 'occupation', 'education',
    'nationality', 'death', 'burial', 'cremation', 'probate', 'mention', 'other'
  ));

create index if not exists person_timeline_events_client_projection_idx
  on public.person_timeline_events (
    project_id,
    person_id,
    (metadata ->> 'clientEventId')
  )
  where metadata ->> 'source' = 'persons_custom_event_projection';

-- A deterministic server id keeps a browser event stable even when the older
-- persons projection deletes and recreates its birth/marriage/death rows.
create or replace function security_private.person_event_projection_id_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_client_event_id text
)
returns uuid
language sql
immutable
strict
set search_path = pg_catalog
as $function$
  with digest as (
    select pg_catalog.md5(
      p_project_id::text || ':' || p_person_id::text || ':' || p_client_event_id
    ) as value
  )
  select (
    pg_catalog.substr(value, 1, 8) || '-' ||
    pg_catalog.substr(value, 9, 4) || '-' ||
    '5' || pg_catalog.substr(value, 14, 3) || '-' ||
    '8' || pg_catalog.substr(value, 18, 3) || '-' ||
    pg_catalog.substr(value, 21, 12)
  )::uuid
  from digest;
$function$;

-- Only a complete calendar date is copied into event_date. Year-only,
-- ranges, circa/before/after text and invalid dates remain verbatim in
-- date_text; no January 1 or other synthetic day is invented.
create or replace function security_private.person_event_exact_date_text_v1(
  p_date_text text
)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $function$
declare
  normalized text := pg_catalog.btrim(coalesce(p_date_text, ''));
begin
  if normalized !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return '';
  end if;
  begin
    perform normalized::date;
  exception when datetime_field_overflow or invalid_datetime_format then
    return '';
  end;
  return normalized;
end;
$function$;

create or replace function security_private.sync_person_event_places_from_person_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  raw_events jsonb := coalesce(
    new.custom_fields -> '__trackerRoduPersonEvents',
    '[]'::jsonb
  );
  event_json jsonb;
  event_key text;
  event_type_value text;
  event_title text;
  event_date_text text;
  event_place_name text;
  event_original_text text;
  event_notes text;
  event_geo jsonb;
  event_place_id uuid;
  event_place_id_text text;
  event_resolution_status text;
  stable_event_id uuid;
  target_event_id uuid;
  projected_core_count integer;
  is_core_synthetic boolean;
  has_place_contract boolean;
  has_core_fact boolean;
  event_place_lock_ids uuid[] := array[]::uuid[];
begin
  if pg_catalog.jsonb_typeof(raw_events) <> 'array' then
    raise exception 'PERSON_EVENTS_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(raw_events) > 1000 then
    raise exception 'PERSON_EVENTS_LIMIT_EXCEEDED' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(raw_events) item(value)
    group by pg_catalog.btrim(coalesce(item.value ->> 'id', ''))
    having pg_catalog.count(*) > 1
  ) then
    raise exception 'PERSON_EVENT_CLIENT_ID_DUPLICATE' using errcode = '22023';
  end if;

  -- The person bridge can update/delete several projected rows.  Lock every
  -- currently linked and explicitly requested Place once, in canonical UUID
  -- order, before any event row is touched.  Row triggers remain a fail-fast
  -- guard if a concurrent writer changes the set after this preflight read.
  select coalesce(pg_catalog.array_agg(distinct event_row.place_id order by event_row.place_id), array[]::uuid[])
  into event_place_lock_ids
  from public.person_timeline_events event_row
  where event_row.project_id = new.project_id
    and event_row.person_id = new.id
    and event_row.place_id is not null;

  for event_json in
    select item.value
    from pg_catalog.jsonb_array_elements(raw_events) with ordinality item(value, position)
    order by item.position
  loop
    if pg_catalog.jsonb_typeof(event_json) = 'object' then
      event_place_id_text := pg_catalog.btrim(coalesce(event_json ->> 'placeId', ''));
      if event_place_id_text <> '' then
        begin
          event_place_lock_ids := pg_catalog.array_append(
            event_place_lock_ids,
            event_place_id_text::uuid
          );
        exception when invalid_text_representation then
          raise exception 'PERSON_EVENT_PLACE_ID_INVALID' using errcode = '22023';
        end;
      end if;
    end if;
  end loop;

  perform security_private.lock_historical_place_ids_v1(event_place_lock_ids, true);

  for event_json in
    select item.value
    from pg_catalog.jsonb_array_elements(raw_events) with ordinality item(value, position)
    order by item.position
  loop
    if pg_catalog.jsonb_typeof(event_json) <> 'object' then
      raise exception 'PERSON_EVENT_ITEM_INVALID' using errcode = '22023';
    end if;

    event_key := pg_catalog.btrim(coalesce(event_json ->> 'id', ''));
    if event_key = '' or pg_catalog.char_length(event_key) > 200 then
      raise exception 'PERSON_EVENT_CLIENT_ID_INVALID' using errcode = '22023';
    end if;

    event_type_value := pg_catalog.btrim(coalesce(event_json ->> 'type', 'other'));
    if event_type_value not in (
      'birth', 'baptism', 'christening', 'marriage', 'divorce', 'residence',
      'census', 'revision_list', 'confession_list', 'household_register',
      'immigration', 'emigration', 'military', 'occupation', 'education',
      'nationality', 'death', 'burial', 'cremation', 'probate', 'mention', 'other'
    ) then
      raise exception 'PERSON_EVENT_TYPE_INVALID' using errcode = '22023';
    end if;

    event_title := coalesce(event_json ->> 'title', '');
    event_date_text := coalesce(event_json ->> 'date', '');
    event_place_name := coalesce(event_json ->> 'placeName', '');
    event_notes := coalesce(event_json ->> 'notes', '');
    event_geo := case
      when pg_catalog.jsonb_typeof(event_json -> 'geo') = 'object'
        then event_json -> 'geo'
      else null
    end;
    has_place_contract := event_json ? 'placeId'
      or event_json ? 'placeOriginalText'
      or event_json ? 'placeResolutionStatus';
    event_original_text := case
      when event_json ? 'placeOriginalText'
        then coalesce(event_json ->> 'placeOriginalText', '')
      else event_place_name
    end;
    event_place_id_text := pg_catalog.btrim(coalesce(event_json ->> 'placeId', ''));
    event_place_id := null;
    if event_place_id_text <> '' then
      begin
        event_place_id := event_place_id_text::uuid;
      exception when invalid_text_representation then
        raise exception 'PERSON_EVENT_PLACE_ID_INVALID' using errcode = '22023';
      end;
    end if;
    event_resolution_status := case
      when event_place_id is null then 'unresolved'
      when event_json ->> 'placeResolutionStatus' = 'needs_review' then 'needs_review'
      else 'confirmed'
    end;

    is_core_synthetic := event_key = event_type_value
      and event_type_value in ('birth', 'marriage', 'death', 'residence');
    has_core_fact := event_date_text <> ''
      or event_place_name <> ''
      or event_original_text <> ''
      or event_place_id is not null
      or event_geo is not null;
    if is_core_synthetic and not has_core_fact then
      continue;
    end if;

    stable_event_id := security_private.person_event_projection_id_v1(
      new.project_id,
      new.id,
      event_key
    );
    target_event_id := null;
    projected_core_count := 0;

    if is_core_synthetic then
      select pg_catalog.count(*), pg_catalog.min(event_row.id::text)::uuid
      into projected_core_count, target_event_id
      from public.person_timeline_events event_row
      where event_row.project_id = new.project_id
        and event_row.person_id = new.id
        and event_row.event_type = event_type_value
        and event_row.metadata ->> 'source' = 'persons_projection';

      if projected_core_count > 1 then
        raise exception 'PERSON_EVENT_PROJECTION_AMBIGUOUS' using errcode = '21000';
      end if;
    end if;

    if target_event_id is not null and target_event_id <> stable_event_id then
      if exists (
        select 1
        from public.person_timeline_events collision
        where collision.id = stable_event_id
          and not (
            collision.project_id = new.project_id
            and collision.person_id = new.id
            and collision.metadata ->> 'source' = 'persons_custom_event_projection'
            and collision.metadata ->> 'clientEventId' = event_key
          )
      ) then
        raise exception 'PERSON_EVENT_STABLE_ID_COLLISION' using errcode = '23505';
      end if;

      delete from public.person_timeline_events old_bridge
      where old_bridge.id = stable_event_id
        and old_bridge.project_id = new.project_id
        and old_bridge.person_id = new.id
        and old_bridge.metadata ->> 'source' = 'persons_custom_event_projection'
        and old_bridge.metadata ->> 'clientEventId' = event_key;

      update public.person_timeline_events event_row
      set
        id = stable_event_id,
        metadata = coalesce(event_row.metadata, '{}'::jsonb)
          || pg_catalog.jsonb_build_object('clientEventId', event_key)
      where event_row.id = target_event_id;
      target_event_id := stable_event_id;
    end if;

    if target_event_id is null then
      if exists (
        select 1
        from public.person_timeline_events collision
        where collision.id = stable_event_id
          and not (
            collision.project_id = new.project_id
            and collision.person_id = new.id
            and collision.metadata ->> 'source' = 'persons_custom_event_projection'
            and collision.metadata ->> 'clientEventId' = event_key
          )
      ) then
        raise exception 'PERSON_EVENT_STABLE_ID_COLLISION' using errcode = '23505';
      end if;

      insert into public.person_timeline_events (
        id, project_id, person_id, event_type, title, event_date, date_text,
        place_name, place_id, place_original_text, place_resolution_status,
        geo, notes, metadata
      ) values (
        stable_event_id,
        new.project_id,
        new.id,
        event_type_value,
        event_title,
        security_private.person_event_exact_date_text_v1(event_date_text),
        event_date_text,
        event_place_name,
        case when has_place_contract then event_place_id else null end,
        case when has_place_contract then event_original_text else event_place_name end,
        case when has_place_contract then event_resolution_status else 'unresolved' end,
        event_geo,
        event_notes,
        pg_catalog.jsonb_build_object(
          'source', 'persons_custom_event_projection',
          'clientEventId', event_key
        )
      )
      on conflict (id) do update set
        event_type = excluded.event_type,
        title = excluded.title,
        event_date = excluded.event_date,
        date_from = '',
        date_to = '',
        date_text = excluded.date_text,
        place_name = excluded.place_name,
        -- An older client does not know the additive historical-place keys.
        -- Its unrelated event edit must not erase a link created by a newer
        -- client. Explicit keys (including an explicit null placeId) still
        -- apply the user's current choice.
        place_id = case
          when has_place_contract then excluded.place_id
          else person_timeline_events.place_id
        end,
        place_original_text = case
          when has_place_contract then excluded.place_original_text
          else person_timeline_events.place_original_text
        end,
        place_resolution_status = case
          when has_place_contract then excluded.place_resolution_status
          else person_timeline_events.place_resolution_status
        end,
        geo = excluded.geo,
        notes = excluded.notes,
        metadata = excluded.metadata,
        updated_at = pg_catalog.now();
      target_event_id := stable_event_id;
    elsif has_place_contract then
      update public.person_timeline_events event_row
      set
        place_id = event_place_id,
        place_original_text = event_original_text,
        place_resolution_status = event_resolution_status,
        metadata = coalesce(event_row.metadata, '{}'::jsonb)
          || pg_catalog.jsonb_build_object('clientEventId', event_key),
        updated_at = pg_catalog.now()
      where event_row.id = target_event_id;
    end if;
  end loop;

  delete from public.person_timeline_events old_projection
  where old_projection.project_id = new.project_id
    and old_projection.person_id = new.id
    and old_projection.metadata ->> 'source' = 'persons_custom_event_projection'
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(raw_events) item(value)
      where pg_catalog.btrim(coalesce(item.value ->> 'id', '')) =
        old_projection.metadata ->> 'clientEventId'
    );

  return new;
end;
$function$;

drop trigger if exists zz_persons_historical_place_event_bridge_insert
  on public.persons;
create trigger zz_persons_historical_place_event_bridge_insert
after insert on public.persons
for each row execute function
  security_private.sync_person_event_places_from_person_v1();

drop trigger if exists zz_persons_historical_place_event_bridge_update
  on public.persons;
create trigger zz_persons_historical_place_event_bridge_update
after update of
  custom_fields,
  birth_date,
  birth_year_from,
  birth_year_to,
  birth_place,
  marriage_date,
  marriage_place,
  death_date,
  death_year_from,
  death_year_to,
  death_place,
  residence_places
on public.persons
for each row
when (
  row(
    old.custom_fields,
    old.birth_date, old.birth_year_from, old.birth_year_to, old.birth_place,
    old.marriage_date, old.marriage_place,
    old.death_date, old.death_year_from, old.death_year_to, old.death_place,
    old.residence_places
  ) is distinct from row(
    new.custom_fields,
    new.birth_date, new.birth_year_from, new.birth_year_to, new.birth_place,
    new.marriage_date, new.marriage_place,
    new.death_date, new.death_year_from, new.death_year_to, new.death_place,
    new.residence_places
  )
)
execute function security_private.sync_person_event_places_from_person_v1();

revoke all on function
  security_private.person_event_projection_id_v1(uuid,uuid,text),
  security_private.person_event_exact_date_text_v1(text),
  security_private.sync_person_event_places_from_person_v1()
  from public, anon, authenticated, service_role;

analyze public.person_timeline_events;
notify pgrst, 'reload schema';

commit;
