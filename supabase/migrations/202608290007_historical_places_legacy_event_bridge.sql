begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

-- Existing person events predate the Historical Places catalogue. This
-- explicit, project-scoped bridge previews or imports their literal place text
-- without rewriting the source wording and without making anything public.
create or replace function security_private.bridge_legacy_person_event_places_v1(
  p_project_id uuid,
  p_apply boolean default false,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '30s'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_actionable_total integer := 0;
  v_candidate_names integer := 0;
  v_candidate_events integer := 0;
  v_existing_places integer := 0;
  v_places_to_create integer := 0;
  v_ambiguous_names integer := 0;
  v_invalid_names integer := 0;
  v_created_places integer := 0;
  v_linked_events integer := 0;
  v_remaining_names integer := 0;
  v_created jsonb;
  v_place_id uuid;
  candidate record;
begin
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  perform security_private.require_historical_project_edit_v1(p_project_id);

  -- Recalculate under a project-scoped transaction lock before applying, so
  -- parallel tabs/retries cannot create the same private place twice.
  if coalesce(p_apply, false) then
    perform pg_advisory_xact_lock(hashtextextended(
      'legacy-person-event-places|' || p_project_id::text,
      0
    ));
  end if;

  select count(*)::integer
  into v_invalid_names
  from (
    select
      public.historical_place_search_normalize_v1(event_row.place_name) as normalized_name,
      (array_agg(
        btrim(event_row.place_name)
        order by char_length(btrim(event_row.place_name)), btrim(event_row.place_name)
      ))[1] as original_name
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.place_id is null
      and nullif(btrim(event_row.place_name), '') is not null
    group by public.historical_place_search_normalize_v1(event_row.place_name)
  ) unresolved_names
  where nullif(unresolved_names.normalized_name, '') is null
    or char_length(unresolved_names.original_name) > 500;

  drop table if exists pg_temp.legacy_place_candidates;
  create temporary table legacy_place_candidates on commit drop as
  with unresolved_names as (
    select
      public.historical_place_search_normalize_v1(event_row.place_name) as normalized_name,
      (array_agg(
        btrim(event_row.place_name)
        order by char_length(btrim(event_row.place_name)), btrim(event_row.place_name)
      ))[1] as original_name,
      count(*)::integer as event_count,
      min(event_row.created_at) as first_created_at
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.place_id is null
      and nullif(btrim(event_row.place_name), '') is not null
      and nullif(public.historical_place_search_normalize_v1(event_row.place_name), '') is not null
    group by public.historical_place_search_normalize_v1(event_row.place_name)
  ), selected_names as (
    select *
    from unresolved_names
    where char_length(original_name) between 1 and 500
  ), matching_places as (
    select
      selected.normalized_name,
      place_row.id as place_id
    from selected_names selected
    join public.places place_row
      on (
        public.historical_place_search_normalize_v1(place_row.canonical_name)
          = selected.normalized_name
        or public.historical_place_search_normalize_v1(place_row.modern_name)
          = selected.normalized_name
        or exists (
          select 1
          from public.place_names name_row
          where name_row.place_id = place_row.id
            and name_row.search_text = selected.normalized_name
        )
      )
    where (
      place_row.project_id = p_project_id
      and place_row.status = any (array['active', 'needs_review']::text[])
    ) or (
      place_row.project_id is null
      and place_row.is_public
      and place_row.status = 'active'
      and place_row.verification_status = 'verified'
    )
    group by selected.normalized_name, place_row.id
  )
  select
    selected.normalized_name,
    selected.original_name,
    selected.event_count,
    selected.first_created_at,
    count(matching.place_id)::integer as match_count,
    min(matching.place_id::text)::uuid as matched_place_id,
    null::uuid as resolved_place_id,
    false::boolean as selected_for_batch
  from selected_names selected
  left join matching_places matching
    on matching.normalized_name = selected.normalized_name
  group by selected.normalized_name, selected.original_name,
    selected.event_count, selected.first_created_at;

  update legacy_place_candidates candidate_row
  set selected_for_batch = true
  where candidate_row.normalized_name in (
    select batch.normalized_name
    from legacy_place_candidates batch
    where batch.match_count <= 1
    order by batch.first_created_at, batch.normalized_name
    limit v_limit
  );

  select
    count(*) filter (where selected_for_batch)::integer,
    coalesce(sum(event_count) filter (where selected_for_batch), 0)::integer,
    count(*) filter (where selected_for_batch and match_count = 1)::integer,
    count(*) filter (where selected_for_batch and match_count = 0)::integer,
    count(*) filter (where match_count > 1)::integer,
    count(*) filter (where match_count <= 1)::integer
  into
    v_candidate_names,
    v_candidate_events,
    v_existing_places,
    v_places_to_create,
    v_ambiguous_names,
    v_actionable_total
  from legacy_place_candidates;

  if coalesce(p_apply, false) then
    for candidate in
      select *
      from legacy_place_candidates
      where selected_for_batch
      order by first_created_at, normalized_name
    loop
      v_place_id := candidate.matched_place_id;
      if v_place_id is null then
        v_created := security_private.create_project_place_v2(
          p_project_id,
          jsonb_build_object(
            'canonicalName', candidate.original_name,
            'needsIdentification', true,
            'status', 'needs_review',
            'verificationStatus', 'unverified',
            'placeType', 'settlement',
            'metadata', jsonb_build_object(
              'importSource', 'legacy_person_timeline_events',
              'requiresReview', true
            )
          )
        );
        v_place_id := nullif(v_created #>> '{place,id}', '')::uuid;
        if v_place_id is null then
          raise exception 'LEGACY_PLACE_CREATE_INVALID_RESPONSE' using errcode = 'P0002';
        end if;
        v_created_places := v_created_places + 1;
      end if;

      update legacy_place_candidates
      set resolved_place_id = v_place_id
      where normalized_name = candidate.normalized_name;
    end loop;

    update public.person_timeline_events event_row
    set
      place_id = candidate.resolved_place_id,
      place_original_text = case
        when nullif(btrim(event_row.place_original_text), '') is null
          then event_row.place_name
        else event_row.place_original_text
      end,
      place_resolution_status = 'needs_review',
      updated_at = pg_catalog.now()
    from legacy_place_candidates candidate
    where event_row.project_id = p_project_id
      and event_row.place_id is null
      and candidate.resolved_place_id is not null
      and public.historical_place_search_normalize_v1(event_row.place_name)
        = candidate.normalized_name;
    get diagnostics v_linked_events = row_count;

    v_remaining_names := greatest(v_actionable_total - v_candidate_names, 0);
  else
    v_remaining_names := v_actionable_total;
  end if;

  return jsonb_build_object(
    'candidateNames', v_candidate_names,
    'candidateEvents', v_candidate_events,
    'existingPlaces', v_existing_places,
    'placesToCreate', v_places_to_create,
    'ambiguousNames', v_ambiguous_names,
    'invalidNames', v_invalid_names,
    'createdPlaces', v_created_places,
    'linkedEvents', v_linked_events,
    'remainingNames', v_remaining_names,
    'hasMore', v_remaining_names > case
      when coalesce(p_apply, false) then 0
      else v_candidate_names
    end,
    'applied', coalesce(p_apply, false)
  );
end;
$function$;

create or replace function public.bridge_legacy_person_event_places_v1(
  p_project_id uuid,
  p_apply boolean default false,
  p_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.bridge_legacy_person_event_places_v1($1, $2, $3);
$wrapper$;

comment on function public.bridge_legacy_person_event_places_v1(uuid, boolean, integer) is
  'Previews or explicitly imports unresolved legacy event place text into a project-private, needs-review catalogue without changing place_name.';

revoke all on function
  security_private.bridge_legacy_person_event_places_v1(uuid, boolean, integer),
  public.bridge_legacy_person_event_places_v1(uuid, boolean, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.bridge_legacy_person_event_places_v1(uuid, boolean, integer),
  public.bridge_legacy_person_event_places_v1(uuid, boolean, integer)
  to authenticated;

notify pgrst, 'reload schema';

commit;
