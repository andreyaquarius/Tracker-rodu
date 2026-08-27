begin;

-- Fail closed if the security-isolation migration is missing.  Without this
-- guard CREATE OR REPLACE could create a new function with a default PUBLIC
-- EXECUTE grant in an out-of-order restored environment.
do $implementation_guard$
begin
  if pg_catalog.to_regprocedure(
    'security_private.get_public_zagulyaka_api_v1(text)'
  ) is null then
    raise exception 'ZAGULYAKA_PUBLIC_DETAIL_IMPLEMENTATION_NOT_FOUND';
  end if;
end;
$implementation_guard$;

-- The public detail facade was moved to security_private by 202608250005,
-- preserving the SQL body introduced by the map-coordinates migration.  Its
-- single-row CTE was eligible for planner inlining, so every reference to the
-- payload could rebuild the complete detail JSON.  Casting the indexed UUID
-- column to text also forced full scans of zagulyaky_records.  At catalogue
-- scale that combination made a single detail request exceed the API timeout.
--
-- Materialize the canonical payload exactly once and keep UUID comparisons on
-- the indexed column side.  The returned JSON and the public RPC contract stay
-- unchanged.
create or replace function security_private.get_public_zagulyaka_api_v1(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as materialized (
    select security_private.get_public_zagulyaka_v1($1) as payload
  )
  select case
    when source.payload is null then null
    when exists (
      select 1
      from public.zagulyaky_records record_row
      where record_row.id = (source.payload ->> 'id')::uuid
        and record_row.possible_living_person
        and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
    ) then null
    else jsonb_set(
      source.payload,
      '{publicAttachments}',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', attachment.value -> 'id',
          'fileName', attachment.value -> 'fileName',
          'mimeType', attachment.value -> 'mimeType',
          'byteSize', attachment.value -> 'byteSize'
        ) order by attachment.ordinality)
        from jsonb_array_elements(coalesce(source.payload -> 'publicAttachments', '[]'::jsonb))
          with ordinality as attachment(value, ordinality)
      ), '[]'::jsonb),
      true
    ) || coalesce(
      security_private.zagulyaky_public_facebook_origin_v1((source.payload ->> 'id')::uuid),
      '{}'::jsonb
    ) || coalesce((
      select jsonb_build_object(
        'originGeo', record_row.origin_geo,
        'foundGeo', record_row.found_geo
      )
      from public.zagulyaky_records record_row
      where record_row.id = (source.payload ->> 'id')::uuid
    ), '{}'::jsonb)
  end
  from source
$function$;

-- CREATE OR REPLACE retains the established ACL.  Reassert it explicitly so
-- this migration remains safe if a restored environment has broader defaults.
revoke all on function security_private.get_public_zagulyaka_api_v1(text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_public_zagulyaka_api_v1(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
