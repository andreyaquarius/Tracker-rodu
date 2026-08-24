begin;

-- These are deliberately private, author-owned shortcuts for entering a
-- batch of Zagulyaky.  They are not catalogue records and must never be
-- linked to a record: a saved shortcut can be renamed or deleted without
-- changing a draft, a moderated record, or anything public.
create table if not exists public.zagulyaky_saved_places (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  geo jsonb not null,
  identity_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint zagulyaky_saved_places_name_check
    check (char_length(name) between 1 and 500),
  constraint zagulyaky_saved_places_geo_check
    check (security_private.zagulyaky_geo_point_is_canonical_v1(geo)),
  constraint zagulyaky_saved_places_owner_identity_key_key
    unique (owner_id, identity_key)
);

create index if not exists zagulyaky_saved_places_owner_updated_idx
  on public.zagulyaky_saved_places(owner_id, updated_at desc, id desc);

create table if not exists public.zagulyaky_saved_source_presets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  institution_name text not null default '',
  archive_reference text not null default '',
  source_title text not null default '',
  source_url text,
  identity_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint zagulyaky_saved_source_presets_institution_name_check
    check (char_length(institution_name) <= 500),
  constraint zagulyaky_saved_source_presets_archive_reference_check
    check (char_length(archive_reference) <= 1000),
  constraint zagulyaky_saved_source_presets_source_title_check
    check (char_length(source_title) <= 1000),
  constraint zagulyaky_saved_source_presets_source_url_check
    check (source_url is null or source_url ~* '^https?://'),
  constraint zagulyaky_saved_source_presets_not_empty_check
    check (
      institution_name <> ''
      or archive_reference <> ''
      or source_title <> ''
      or source_url is not null
    ),
  constraint zagulyaky_saved_source_presets_owner_identity_key_key
    unique (owner_id, identity_key)
);

create index if not exists zagulyaky_saved_source_presets_owner_updated_idx
  on public.zagulyaky_saved_source_presets(owner_id, updated_at desc, id desc);

alter table public.zagulyaky_saved_places enable row level security;
alter table public.zagulyaky_saved_source_presets enable row level security;

-- Keep a defence-in-depth owner policy even though browser table privileges
-- are revoked below.  The only supported browser interface is the RPC layer.
drop policy if exists zagulyaky_saved_places_owner_only on public.zagulyaky_saved_places;
create policy zagulyaky_saved_places_owner_only
  on public.zagulyaky_saved_places
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists zagulyaky_saved_source_presets_owner_only on public.zagulyaky_saved_source_presets;
create policy zagulyaky_saved_source_presets_owner_only
  on public.zagulyaky_saved_source_presets
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create or replace function security_private.zagulyaky_saved_input_key_v1(
  p_values text[]
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select array_to_string(
    array(
      select regexp_replace(lower(btrim(coalesce(item, ''))), '[[:space:]]+', ' ', 'g')
      from unnest(coalesce(p_values, '{}'::text[])) as item
    ),
    E'\x1f'
  );
$function$;

create or replace function public.list_my_zagulyaky_saved_places_v1(
  p_query text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  search_text text := nullif(btrim(coalesce(p_query, '')), '');
  safe_limit integer := coalesce(p_limit, 100);
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if char_length(coalesce(search_text, '')) > 500 or safe_limit not between 1 and 200 then
    raise exception 'INVALID_ZAGULYAKA_SAVED_INPUT_QUERY' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', place_row.id,
      'name', place_row.name,
      'geo', place_row.geo,
      'createdAt', place_row.created_at,
      'updatedAt', place_row.updated_at
    ) order by place_row.updated_at desc, place_row.id desc)
    from (
      select place_row.*
      from public.zagulyaky_saved_places place_row
      where place_row.owner_id = current_user_id
        and (search_text is null or place_row.name ilike '%' || search_text || '%')
      order by place_row.updated_at desc, place_row.id desc
      limit safe_limit
    ) place_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.upsert_my_zagulyaky_saved_place_v1(
  p_place jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  requested_id uuid;
  saved_name text;
  canonical_geo jsonb;
  saved_key text;
  saved_row public.zagulyaky_saved_places;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place is null or jsonb_typeof(p_place) <> 'object' or octet_length(p_place::text) > 8192 then
    raise exception 'INVALID_ZAGULYAKA_SAVED_PLACE' using errcode = '22023';
  end if;
  if jsonb_typeof(p_place -> 'name') is distinct from 'string'
    or (p_place ? 'id' and jsonb_typeof(p_place -> 'id') <> 'string') then
    raise exception 'INVALID_ZAGULYAKA_SAVED_PLACE' using errcode = '22023';
  end if;

  saved_name := regexp_replace(btrim(coalesce(p_place ->> 'name', '')), '[[:space:]]+', ' ', 'g');
  if char_length(saved_name) not between 1 and 500 then
    raise exception 'INVALID_ZAGULYAKA_SAVED_PLACE_NAME' using errcode = '22023';
  end if;
  canonical_geo := security_private.normalize_zagulyaky_geo_point_v1(p_place -> 'geo');
  if canonical_geo is null then
    raise exception 'ZAGULYAKA_SAVED_PLACE_GEO_REQUIRED' using errcode = '22023';
  end if;
  saved_key := security_private.zagulyaky_saved_input_key_v1(array[
    saved_name,
    canonical_geo ->> 'latitude',
    canonical_geo ->> 'longitude'
  ]);

  if nullif(btrim(coalesce(p_place ->> 'id', '')), '') is not null then
    begin
      requested_id := (p_place ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_ZAGULYAKA_SAVED_PLACE_ID' using errcode = '22023';
    end;

    update public.zagulyaky_saved_places
    set name = saved_name,
        geo = canonical_geo,
        identity_key = saved_key,
        updated_at = now()
    where id = requested_id and owner_id = current_user_id
    returning * into saved_row;
    if not found then
      raise exception 'ZAGULYAKA_SAVED_PLACE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    insert into public.zagulyaky_saved_places (owner_id, name, geo, identity_key)
    values (current_user_id, saved_name, canonical_geo, saved_key)
    on conflict (owner_id, identity_key) do update
      set name = excluded.name,
          geo = excluded.geo,
          updated_at = now()
    returning * into saved_row;
  end if;

  return jsonb_build_object(
    'id', saved_row.id,
    'name', saved_row.name,
    'geo', saved_row.geo,
    'createdAt', saved_row.created_at,
    'updatedAt', saved_row.updated_at
  );
end;
$function$;

create or replace function public.delete_my_zagulyaky_saved_place_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  deleted_count integer;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_place_id is null then
    raise exception 'INVALID_ZAGULYAKA_SAVED_PLACE_ID' using errcode = '22023';
  end if;
  delete from public.zagulyaky_saved_places
  where id = p_place_id and owner_id = current_user_id;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('deleted', deleted_count = 1);
end;
$function$;

create or replace function public.list_my_zagulyaky_saved_source_presets_v1(
  p_query text default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  search_text text := nullif(btrim(coalesce(p_query, '')), '');
  safe_limit integer := coalesce(p_limit, 100);
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if char_length(coalesce(search_text, '')) > 1000 or safe_limit not between 1 and 200 then
    raise exception 'INVALID_ZAGULYAKA_SAVED_INPUT_QUERY' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', source_row.id,
      'institutionName', source_row.institution_name,
      'archiveReference', source_row.archive_reference,
      'sourceTitle', source_row.source_title,
      'sourceUrl', source_row.source_url,
      'createdAt', source_row.created_at,
      'updatedAt', source_row.updated_at
    ) order by source_row.updated_at desc, source_row.id desc)
    from (
      select source_row.*
      from public.zagulyaky_saved_source_presets source_row
      where source_row.owner_id = current_user_id
        and (
          search_text is null
          or concat_ws(' ', source_row.institution_name, source_row.archive_reference, source_row.source_title, source_row.source_url)
            ilike '%' || search_text || '%'
        )
      order by source_row.updated_at desc, source_row.id desc
      limit safe_limit
    ) source_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.upsert_my_zagulyaky_saved_source_preset_v1(
  p_source jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  requested_id uuid;
  saved_institution_name text;
  saved_archive_reference text;
  saved_source_title text;
  saved_source_url text;
  saved_key text;
  saved_row public.zagulyaky_saved_source_presets;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_source is null or jsonb_typeof(p_source) <> 'object' or octet_length(p_source::text) > 8192 then
    raise exception 'INVALID_ZAGULYAKA_SAVED_SOURCE' using errcode = '22023';
  end if;
  if (p_source ? 'id' and jsonb_typeof(p_source -> 'id') <> 'string')
    or (p_source ? 'institutionName' and jsonb_typeof(p_source -> 'institutionName') <> 'string')
    or (p_source ? 'archiveReference' and jsonb_typeof(p_source -> 'archiveReference') <> 'string')
    or (p_source ? 'sourceTitle' and jsonb_typeof(p_source -> 'sourceTitle') <> 'string')
    or (p_source ? 'sourceUrl' and jsonb_typeof(p_source -> 'sourceUrl') <> 'string') then
    raise exception 'INVALID_ZAGULYAKA_SAVED_SOURCE' using errcode = '22023';
  end if;

  saved_institution_name := regexp_replace(btrim(coalesce(p_source ->> 'institutionName', '')), '[[:space:]]+', ' ', 'g');
  saved_archive_reference := regexp_replace(btrim(coalesce(p_source ->> 'archiveReference', '')), '[[:space:]]+', ' ', 'g');
  saved_source_title := regexp_replace(btrim(coalesce(p_source ->> 'sourceTitle', '')), '[[:space:]]+', ' ', 'g');
  saved_source_url := nullif(btrim(coalesce(p_source ->> 'sourceUrl', '')), '');
  if char_length(saved_institution_name) > 500
    or char_length(saved_archive_reference) > 1000
    or char_length(saved_source_title) > 1000
    or (saved_source_url is not null and (char_length(saved_source_url) > 2048 or saved_source_url !~* '^https?://')) then
    raise exception 'INVALID_ZAGULYAKA_SAVED_SOURCE' using errcode = '22023';
  end if;
  if saved_institution_name = '' and saved_archive_reference = '' and saved_source_title = '' and saved_source_url is null then
    raise exception 'ZAGULYAKA_SAVED_SOURCE_EMPTY' using errcode = '22023';
  end if;
  saved_key := security_private.zagulyaky_saved_input_key_v1(array[
    saved_institution_name,
    saved_archive_reference,
    saved_source_title,
    coalesce(saved_source_url, '')
  ]);

  if nullif(btrim(coalesce(p_source ->> 'id', '')), '') is not null then
    begin
      requested_id := (p_source ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception 'INVALID_ZAGULYAKA_SAVED_SOURCE_ID' using errcode = '22023';
    end;

    update public.zagulyaky_saved_source_presets
    set institution_name = saved_institution_name,
        archive_reference = saved_archive_reference,
        source_title = saved_source_title,
        source_url = saved_source_url,
        identity_key = saved_key,
        updated_at = now()
    where id = requested_id and owner_id = current_user_id
    returning * into saved_row;
    if not found then
      raise exception 'ZAGULYAKA_SAVED_SOURCE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    insert into public.zagulyaky_saved_source_presets (
      owner_id, institution_name, archive_reference, source_title, source_url, identity_key
    )
    values (
      current_user_id, saved_institution_name, saved_archive_reference, saved_source_title, saved_source_url, saved_key
    )
    on conflict (owner_id, identity_key) do update
      set institution_name = excluded.institution_name,
          archive_reference = excluded.archive_reference,
          source_title = excluded.source_title,
          source_url = excluded.source_url,
          updated_at = now()
    returning * into saved_row;
  end if;

  return jsonb_build_object(
    'id', saved_row.id,
    'institutionName', saved_row.institution_name,
    'archiveReference', saved_row.archive_reference,
    'sourceTitle', saved_row.source_title,
    'sourceUrl', saved_row.source_url,
    'createdAt', saved_row.created_at,
    'updatedAt', saved_row.updated_at
  );
end;
$function$;

create or replace function public.delete_my_zagulyaky_saved_source_preset_v1(
  p_source_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  deleted_count integer;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_source_id is null then
    raise exception 'INVALID_ZAGULYAKA_SAVED_SOURCE_ID' using errcode = '22023';
  end if;
  delete from public.zagulyaky_saved_source_presets
  where id = p_source_id and owner_id = current_user_id;
  get diagnostics deleted_count = row_count;
  return jsonb_build_object('deleted', deleted_count = 1);
end;
$function$;

revoke all on table public.zagulyaky_saved_places
  from public, anon, authenticated;
revoke all on table public.zagulyaky_saved_source_presets
  from public, anon, authenticated;
grant all on table public.zagulyaky_saved_places to service_role;
grant all on table public.zagulyaky_saved_source_presets to service_role;

revoke all on function security_private.zagulyaky_saved_input_key_v1(text[])
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_zagulyaky_saved_places_v1(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_my_zagulyaky_saved_place_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaky_saved_place_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_zagulyaky_saved_source_presets_v1(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaky_saved_source_preset_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_my_zagulyaky_saved_places_v1(text, integer)
  to authenticated, service_role;
grant execute on function public.upsert_my_zagulyaky_saved_place_v1(jsonb)
  to authenticated, service_role;
grant execute on function public.delete_my_zagulyaky_saved_place_v1(uuid)
  to authenticated, service_role;
grant execute on function public.list_my_zagulyaky_saved_source_presets_v1(text, integer)
  to authenticated, service_role;
grant execute on function public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb)
  to authenticated, service_role;
grant execute on function public.delete_my_zagulyaky_saved_source_preset_v1(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
