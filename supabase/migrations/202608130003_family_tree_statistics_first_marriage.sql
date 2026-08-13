-- Count the first marriage from the canonical family relationship created by
-- GEDCOM imports. The previous report only read persons.marriage_date, so it
-- ignored almost every family-level MARR record.

create or replace function security_private.family_tree_statistics_first_marriage_year_v1(
  p_person_id uuid,
  p_tree_id uuid,
  p_legacy_marriage_date text default null
)
returns integer
language sql
stable
set search_path = pg_catalog
as $function$
  with candidate_years as (
    select security_private.family_tree_statistics_year_v1(
      relation.start_date,
      null,
      null
    ) as marriage_year
    from public.partner_relationships relation
    where relation.tree_id = p_tree_id
      and relation.evidence_status <> 'disproven'
      and relation.relationship_type in (
        'marriage',
        'divorced',
        'separated',
        'annulled',
        'widowhood'
      )
      and p_person_id in (relation.person_a_id, relation.person_b_id)
      and nullif(trim(relation.start_date), '') is not null

    union all

    select security_private.family_tree_statistics_year_v1(
      event.event_date,
      event.date_from,
      event.date_to
    )
    from public.person_timeline_events event
    where event.person_id = p_person_id
      and event.event_type = 'marriage'
      and event.evidence_status <> 'disproven'

    union all

    select security_private.family_tree_statistics_year_v1(
      p_legacy_marriage_date,
      null,
      null
    )
  )
  select min(candidate_years.marriage_year)
  from candidate_years
  where candidate_years.marriage_year is not null;
$function$;

revoke all on function security_private.family_tree_statistics_first_marriage_year_v1(uuid,uuid,text)
  from public,anon,authenticated,service_role;

-- Patch the already deployed report without duplicating its large audited
-- implementation. New installations receive the same expression directly
-- from 202608120004_family_tree_statistics.sql.
do $migration$
declare
  function_definition text;
  old_fragment constant text :=
    'security_private.family_tree_statistics_year_v1(person.marriage_date,null,null) marriage_year';
  new_fragment constant text :=
    'security_private.family_tree_statistics_first_marriage_year_v1(person.id,current_tree_id,person.marriage_date) marriage_year';
begin
  select pg_get_functiondef(
    'security_private.get_family_tree_statistics_tab_v1(jsonb,text)'::regprocedure
  ) into function_definition;

  if function_definition is null then
    raise exception 'FAMILY_TREE_STATISTICS_FUNCTION_NOT_FOUND';
  end if;

  if position(old_fragment in function_definition) > 0 then
    execute replace(function_definition, old_fragment, new_fragment);
  elsif position(new_fragment in function_definition) = 0 then
    raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_MARRIAGE_DEFINITION';
  end if;
end;
$migration$;

-- Keep drill-down rows in sync with the values shown in the chart.
do $migration$
declare
  function_definition text;
  old_fragment constant text :=
    'security_private.family_tree_statistics_year_v1(person.marriage_date,null,null)';
  new_fragment constant text :=
    'security_private.family_tree_statistics_first_marriage_year_v1(person.id,(meta->>''treeId'')::uuid,person.marriage_date)';
begin
  select pg_get_functiondef(
    'public.list_family_tree_statistics_people_v1(jsonb)'::regprocedure
  ) into function_definition;

  if function_definition is null then
    raise exception 'FAMILY_TREE_STATISTICS_PEOPLE_FUNCTION_NOT_FOUND';
  end if;

  if position(old_fragment in function_definition) > 0 then
    execute replace(function_definition, old_fragment, new_fragment);
  elsif position(new_fragment in function_definition) = 0 then
    raise exception 'UNEXPECTED_FAMILY_TREE_STATISTICS_MARRIAGE_DRILLDOWN_DEFINITION';
  end if;
end;
$migration$;

create index if not exists partner_relationships_first_marriage_person_a_idx
  on public.partner_relationships(tree_id,person_a_id,start_date)
  where evidence_status <> 'disproven'
    and relationship_type in ('marriage','divorced','separated','annulled','widowhood')
    and start_date <> '';

create index if not exists partner_relationships_first_marriage_person_b_idx
  on public.partner_relationships(tree_id,person_b_id,start_date)
  where evidence_status <> 'disproven'
    and relationship_type in ('marriage','divorced','separated','annulled','widowhood')
    and start_date <> '';

delete from security_private.family_tree_statistics_cache
where tab = 'demography';

notify pgrst,'reload schema';
