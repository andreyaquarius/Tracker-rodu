begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- The explorer is a catalogue of settlements, not a picker for a bare
-- governorate/county/region pin. A contextual label may be written either
-- settlement-first or administration-first, so accept it when at least one
-- comma-separated component is not an administrative/country component.
create or replace function security_private.zagulyaky_is_settlement_label_v1(
  p_label text
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  component text;
  normalized_component text;
begin
  if nullif(btrim(coalesce(p_label, '')), '') is null then
    return false;
  end if;

  foreach component in array regexp_split_to_array(p_label, ',')
  loop
    normalized_component := lower(btrim(component));
    if normalized_component = '' then
      continue;
    end if;
    if normalized_component ~ '(^|[[:space:]])(губернія|губерния|губ[.]|область|обл[.]|повіт|повет|пов[.]|уезд|уїзд|район|р-н|округ|окр[.]|громада|міська рада|сільська рада|селищна рада|волость|воєводство|воеводство|край|держава|республіка|республика|імперія|империя)([[:space:]]*\([^)]*\))?$' then
      continue;
    end if;
    if normalized_component ~ '^(україна|росія|россия|польща|білорусь|беларусь|молдова|румунія|румыния|угорщина|венгрия|срср|ссср)([[:space:]]*\([^)]*\))?$' then
      continue;
    end if;
    return true;
  end loop;

  return false;
end;
$function$;

-- Repair legacy duplicate registry rows conservatively. A full contextual
-- label may share one fixed anchor only inside the same 500 m envelope already
-- used by the canonical resolver. This never rewrites source coordinates and
-- never merges an unlimited-distance same-name settlement.
do $reconcile_contextual_places$
declare
  duplicate_pair record;
begin
  loop
    select
      keeper.id as keeper_id,
      duplicate.id as duplicate_id,
      keeper.normalized_label
    into duplicate_pair
    from security_private.zagulyaky_canonical_places keeper
    join security_private.zagulyaky_canonical_places duplicate
      on duplicate.normalized_label = keeper.normalized_label
      and (keeper.created_at, keeper.id) < (duplicate.created_at, duplicate.id)
    where coalesce(array_length(
        regexp_split_to_array(keeper.normalized_label, ','),
        1
      ), 1) >= 3
      and security_private.zagulyaky_place_distance_km_v1(
        keeper.latitude,
        keeper.longitude,
        duplicate.latitude,
        duplicate.longitude
      ) <= 0.5
    order by keeper.created_at, keeper.id, duplicate.created_at, duplicate.id
    limit 1;

    exit when not found;

    -- Use the same lock as the live resolver so a concurrently published pin
    -- cannot race alias reassignment for this contextual label.
    perform pg_advisory_xact_lock(hashtextextended(
      'zagulyaky-place-label|' || duplicate_pair.normalized_label,
      0
    ));

    update security_private.zagulyaky_canonical_place_aliases place_alias
    set place_id = duplicate_pair.keeper_id
    where place_alias.place_id = duplicate_pair.duplicate_id;

    delete from security_private.zagulyaky_canonical_places place_row
    where place_row.id = duplicate_pair.duplicate_id;

    update security_private.zagulyaky_canonical_places place_row
    set
      alias_count = (
        select count(*)::integer
        from security_private.zagulyaky_canonical_place_aliases place_alias
        where place_alias.place_id = duplicate_pair.keeper_id
      ),
      updated_at = pg_catalog.now()
    where place_row.id = duplicate_pair.keeper_id;
  end loop;
end;
$reconcile_contextual_places$;

-- The private, distance-bounded registry remains authoritative. The public
-- key is opaque and contains neither raw coordinates nor private identifiers.
create or replace function security_private.zagulyaky_public_place_key_v1(
  p_geo jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_geo jsonb;
  v_fingerprint text;
  v_place_id uuid;
  v_label text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  v_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  v_label := security_private.normalize_zagulyaky_place_label_v1(v_geo ->> 'displayName');
  if v_label is null or not security_private.zagulyaky_is_settlement_label_v1(v_label) then
    return null;
  end if;

  v_fingerprint := security_private.zagulyaky_raw_place_fingerprint_v1(v_geo);
  if v_fingerprint is null then
    return null;
  end if;

  select place_alias.place_id
  into v_place_id
  from security_private.zagulyaky_canonical_place_aliases place_alias
  where place_alias.raw_fingerprint = v_fingerprint;

  if v_place_id is null then
    return null;
  end if;
  return md5('canonical-place-v1|' || v_place_id::text);
end;
$function$;

create or replace function security_private.zagulyaky_public_place_point_v1(
  p_geo jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_geo jsonb;
  v_display_name text;
  v_place_key text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  v_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  v_display_name := nullif(btrim(coalesce(v_geo ->> 'displayName', '')), '');
  if v_display_name is null
     or not security_private.zagulyaky_is_settlement_label_v1(v_display_name) then
    return null;
  end if;
  v_place_key := security_private.zagulyaky_public_place_key_v1(v_geo);
  if v_place_key is null then
    return null;
  end if;

  return jsonb_build_object(
    'key', v_place_key,
    'label', v_display_name,
    'geo', jsonb_build_object(
      'displayName', v_display_name,
      'latitude', v_geo -> 'latitude',
      'longitude', v_geo -> 'longitude',
      'precision', v_geo -> 'precision'
    )
  );
end;
$function$;

comment on function security_private.zagulyaky_is_settlement_label_v1(text) is
  'Rejects bare administrative/country labels from the public settlement explorer while retaining contextual historical labels.';
comment on function security_private.zagulyaky_public_place_key_v1(jsonb) is
  'Returns an opaque canonical key from the private distance-bounded settlement registry.';

revoke all on function
  security_private.zagulyaky_is_settlement_label_v1(text),
  security_private.zagulyaky_public_place_key_v1(jsonb),
  security_private.zagulyaky_public_place_point_v1(jsonb)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
