begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Existing search_text GIN and project/person indexes are retained. The main
-- regression was row-dependent RLS membership/subscription checks on both
-- sides of the join (also repeated for primary display names).
create or replace function security_private.search_project_person_names_fast_v1(
  p_project_id uuid,
  p_query text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
declare
  raw_query text := coalesce(p_query, '');
  normalized_query text;
  transliterated_query text;
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  can_edit boolean;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or (
    not caller_is_service and not public.is_project_member(p_project_id)
  ) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  -- Evaluate access once, not once for every historical name and joined person.
  can_edit := caller_is_service or public.can_edit_project(p_project_id);
  if char_length(raw_query) > 200 then
    raise exception 'PERSON_NAME_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  normalized_query := public.person_name_search_normalize_v1(raw_query);
  transliterated_query := public.person_name_search_transliterate_v1(raw_query);
  if char_length(normalized_query) < 2 then
    return '[]'::jsonb;
  end if;

  return coalesce((
    with ranked as (
      select
        name.*,
        case
          when name.original_text = raw_query then 0
          when public.person_name_search_normalize_v1(name.original_text) = normalized_query then 1
          when public.person_name_search_normalize_v1(name.full_normalized) = normalized_query then 2
          when not name.is_primary and (
            name.search_text like '%' || normalized_query || '%'
            or name.search_text like '%' || transliterated_query || '%'
          ) then 3
          else 4
        end match_rank,
        greatest(
          extensions.similarity(name.search_text, normalized_query),
          extensions.similarity(name.search_text, transliterated_query)
        ) match_score
      from public.person_names name
      join public.persons person
        on person.id = name.person_id and person.project_id = name.project_id
      where name.project_id = p_project_id
        and name.is_searchable
        and (can_edit or not (person.is_living and person.privacy_status in ('private', 'confidential')))
        and (
          name.search_text like '%' || normalized_query || '%'
          or name.search_text like '%' || transliterated_query || '%'
          or name.search_text % normalized_query
          or name.search_text % transliterated_query
        )
    ), best_per_person as (
      select distinct on (person_id)
        id, person_id, name_type, language_code, script_code, orthography,
        surname, maiden_surname, given_name, patronymic, nickname,
        full_name, original_text, full_normalized, is_primary,
        source_type, source_id, source_document_id, source_finding_id,
        citation_id, document_fragment_id,
        confidence, valid_from, valid_to, date_precision,
        match_rank, match_score
      from ranked
      order by person_id, match_rank, match_score desc, is_primary desc, updated_at desc, id
    )
    select jsonb_agg(jsonb_build_object(
      'personId', result.person_id,
      'personNameId', result.id,
      'displayName', coalesce(
        nullif(display.display_name, ''),
        nullif(result.full_normalized, ''),
        nullif(result.full_name, ''),
        nullif(result.original_text, ''),
        btrim(result.surname || ' ' || result.given_name || ' ' || result.patronymic),
        ''
      ),
      'matchedName', coalesce(
        nullif(result.original_text, ''),
        nullif(result.full_normalized, ''),
        nullif(result.full_name, ''),
        btrim(result.surname || ' ' || result.given_name || ' ' || result.patronymic),
        ''
      ),
      'matchType', case result.match_rank
        when 0 then 'exact'
        when 1 then 'normalized'
        when 2 then 'normalized'
        when 3 then 'variant'
        else 'fuzzy'
      end,
      'score', case result.match_rank
        when 0 then 1::real
        when 1 then 1::real
        when 2 then greatest(0.98::real, result.match_score)
        when 3 then greatest(0.8::real, result.match_score)
        else result.match_score
      end,
      'name', jsonb_build_object(
        'id', result.id,
        'nameType', result.name_type,
        'language', result.language_code,
        'script', result.script_code,
        'orthography', result.orthography,
        'surname', result.surname,
        'maidenSurname', result.maiden_surname,
        'givenName', result.given_name,
        'patronymic', result.patronymic,
        'nickname', result.nickname,
        'fullName', result.full_name,
        'fullOriginal', result.original_text,
        'fullNormalized', result.full_normalized,
        'isPrimary', result.is_primary,
        'sourceType', result.source_type,
        'sourceId', result.source_id,
        'sourceDocumentId', result.source_document_id,
        'sourceFindingId', result.source_finding_id,
        'citationId', result.citation_id,
        'documentFragmentId', result.document_fragment_id,
        'confidence', result.confidence,
        'validFrom', result.valid_from,
        'validTo', result.valid_to,
        'datePrecision', result.date_precision
      )
    ) order by result.match_rank, result.match_score desc, result.person_id)
    from (
      select * from best_per_person
      order by match_rank, match_score desc, person_id
      limit bounded_limit
    ) result
    left join lateral (
      select coalesce(
        nullif(primary_name.full_normalized, ''),
        nullif(primary_name.full_name, ''),
        nullif(primary_name.original_text, ''),
        nullif(btrim(primary_name.surname || ' ' || primary_name.given_name || ' ' || primary_name.patronymic), ''),
        ''
      ) display_name
      from public.person_names primary_name
      where primary_name.project_id = p_project_id
        and primary_name.person_id = result.person_id
        and primary_name.is_primary
      order by primary_name.updated_at desc, primary_name.id
      limit 1
    ) display on true
  ), '[]'::jsonb);
end;
$function$;

revoke all on function security_private.search_project_person_names_fast_v1(uuid,text,integer) from public, anon;
grant usage on schema security_private to authenticated, service_role;
grant execute on function security_private.search_project_person_names_fast_v1(uuid,text,integer) to authenticated, service_role;

create or replace function public.search_project_person_names_v1(
  p_project_id uuid, p_query text, p_limit integer default 20
) returns jsonb language sql stable security invoker
set search_path = pg_catalog
as $function$
  select security_private.search_project_person_names_fast_v1(p_project_id,p_query,p_limit);
$function$;
revoke all on function public.search_project_person_names_v1(uuid,text,integer) from public, anon;
grant execute on function public.search_project_person_names_v1(uuid,text,integer) to authenticated, service_role;
notify pgrst, 'reload schema';
commit;
