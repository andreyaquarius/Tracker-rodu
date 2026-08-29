begin;

create or replace function security_private.list_place_external_identifiers_v1(
  p_place_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  result jsonb;
begin
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;
  if auth.uid() is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(
    jsonb_agg(
      security_private.place_external_identifier_json_v1(identifier_row)
      order by identifier_row.is_primary desc, identifier_row.provider, identifier_row.id
    ),
    '[]'::jsonb
  )
  into result
  from public.place_external_identifiers identifier_row
  where identifier_row.place_id = p_place_id;

  return result;
end;
$function$;

create or replace function public.list_place_external_identifiers_v1(
  p_place_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_place_external_identifiers_v1($1);
$wrapper$;

revoke all on function security_private.list_place_external_identifiers_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_place_external_identifiers_v1(uuid)
  to authenticated, service_role;

revoke all on function public.list_place_external_identifiers_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_place_external_identifiers_v1(uuid)
  to authenticated, service_role;

comment on function public.list_place_external_identifiers_v1(uuid) is
  'Returns the complete RLS-scoped external identifier set for a readable historical Place.';

notify pgrst, 'reload schema';

commit;
