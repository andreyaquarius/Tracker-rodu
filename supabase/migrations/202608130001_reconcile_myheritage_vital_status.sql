begin;

-- MyHeritage keeps a mandatory binary living/deceased flag in its own UI,
-- but its GEDCOM export does not serialize a positive living marker and can
-- omit DEAT Y for people it still classifies as deceased.  Repair only
-- archived MyHeritage imports whose importer metadata is still `unknown`.
-- Explicit statuses and records imported from every other GEDCOM producer are
-- deliberately left untouched.

create temporary table myheritage_vital_status_reconciliation
on commit drop
as
with myheritage_batches as (
  select
    batch.id as batch_id,
    batch.project_id,
    batch.tree_id,
    batch.created_at,
    coalesce(
      (
        select (regexp_match(head_line.value ->> 'value', '(1[0-9]{3}|20[0-9]{2})'))[1]::integer
        from jsonb_array_elements(
          case
            when jsonb_typeof(batch.raw_metadata -> 'unpointed_records') = 'array'
              then batch.raw_metadata -> 'unpointed_records'
            else '[]'::jsonb
          end
        ) as archived_record(value)
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(archived_record.value -> 'lines') = 'array'
              then archived_record.value -> 'lines'
            else '[]'::jsonb
          end
        ) as head_line(value)
        where upper(coalesce(archived_record.value ->> 'tag', '')) = 'HEAD'
          and upper(coalesce(head_line.value ->> 'tag', '')) = 'DATE'
          and coalesce(head_line.value ->> 'value', '') ~ '(1[0-9]{3}|20[0-9]{2})'
        limit 1
      ),
      extract(year from batch.created_at)::integer
    ) as reference_year
  from public.gedcom_import_batches batch
  where batch.status = 'completed'
    and exists (
      select 1
      from jsonb_array_elements(
        case
          when jsonb_typeof(batch.raw_metadata -> 'unpointed_records') = 'array'
            then batch.raw_metadata -> 'unpointed_records'
          else '[]'::jsonb
        end
      ) as archived_record(value)
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(archived_record.value -> 'lines') = 'array'
            then archived_record.value -> 'lines'
          else '[]'::jsonb
        end
      ) as head_line(value)
      where upper(coalesce(archived_record.value ->> 'tag', '')) = 'HEAD'
        and upper(coalesce(head_line.value ->> 'tag', '')) in ('SOUR', 'DEST')
        and upper(coalesce(head_line.value ->> 'value', '')) like '%MYHERITAGE%'
    )
), latest_person_batch as (
  select distinct on (xref.internal_id)
    xref.internal_id as person_id,
    batch.project_id,
    batch.tree_id,
    batch.reference_year,
    batch.created_at
  from myheritage_batches batch
  join public.gedcom_xref_maps xref
    on xref.import_batch_id = batch.batch_id
   and xref.project_id = batch.project_id
   and xref.gedcom_record_type = 'INDI'
   and xref.internal_table = 'persons'
  join public.persons person
    on person.id = xref.internal_id
   and person.project_id = xref.project_id
  where lower(trim(coalesce(person.custom_fields ->> '__gedcomVitalStatus', ''))) = 'unknown'
  order by xref.internal_id, batch.created_at desc, batch.batch_id desc
), evidence as (
  select
    target.person_id,
    target.project_id,
    target.tree_id,
    target.reference_year - 110 as cutoff_year,
    (
      coalesce(
        nullif(trim(person.death_date), ''),
        nullif(trim(person.death_year_from), ''),
        nullif(trim(person.death_year_to), '')
      ) is not null
      or exists (
        select 1
        from public.person_timeline_events event
        where event.project_id = target.project_id
          and event.person_id = target.person_id
          and event.event_type in ('death', 'burial', 'cremation')
      )
      or security_private.family_tree_statistics_year_v1(
        person.birth_date,
        person.birth_year_from,
        person.birth_year_to
      ) < target.reference_year - 110
      or exists (
        select 1
        from public.person_timeline_events event
        where event.project_id = target.project_id
          and event.person_id = target.person_id
          and security_private.family_tree_statistics_year_v1(
            coalesce(nullif(event.event_date, ''), nullif(event.date_text, '')),
            event.date_from,
            event.date_to
          ) < target.reference_year - 110
      )
      or exists (
        select 1
        from public.parent_child_relationships relation
        join public.persons child
          on child.id = relation.child_id
         and child.project_id = relation.project_id
        where relation.tree_id = target.tree_id
          and relation.project_id = target.project_id
          and relation.parent_id = target.person_id
          and relation.evidence_status <> 'disproven'
          and security_private.family_tree_statistics_year_v1(
            child.birth_date,
            child.birth_year_from,
            child.birth_year_to
          ) < target.reference_year - 110
      )
      or exists (
        select 1
        from public.partner_relationships relation
        join public.persons partner
          on partner.id = case
            when relation.person_a_id = target.person_id then relation.person_b_id
            else relation.person_a_id
          end
         and partner.project_id = relation.project_id
        where relation.tree_id = target.tree_id
          and relation.project_id = target.project_id
          and target.person_id in (relation.person_a_id, relation.person_b_id)
          and relation.evidence_status <> 'disproven'
          and security_private.family_tree_statistics_year_v1(
            partner.birth_date,
            partner.birth_year_from,
            partner.birth_year_to
          ) < target.reference_year - 110
      )
    ) as presumed_deceased
  from latest_person_batch target
  join public.persons person
    on person.id = target.person_id
   and person.project_id = target.project_id
)
select
  evidence.person_id,
  evidence.project_id,
  evidence.tree_id,
  case
    when person.is_living then 'living'
    when evidence.presumed_deceased then 'deceased'
    else 'living'
  end as vital_status
from evidence
join public.persons person
  on person.id = evidence.person_id
 and person.project_id = evidence.project_id;

-- Avoid bumping graph_version once per repaired person.  Hold the persons
-- table lock for this short migration, update the records, then invalidate
-- each affected tree exactly once.
alter table public.persons disable trigger persons_bump_family_tree_graph_versions;

update public.persons person
set
  is_living = reconciliation.vital_status = 'living',
  custom_fields = jsonb_set(
    coalesce(person.custom_fields, '{}'::jsonb),
    '{__gedcomVitalStatus}',
    to_jsonb(reconciliation.vital_status),
    true
  ),
  updated_at = now()
from myheritage_vital_status_reconciliation reconciliation
where person.id = reconciliation.person_id
  and person.project_id = reconciliation.project_id
  and lower(trim(coalesce(person.custom_fields ->> '__gedcomVitalStatus', ''))) = 'unknown';

alter table public.persons enable trigger persons_bump_family_tree_graph_versions;

update public.family_trees tree
set
  graph_version = tree.graph_version + 1,
  updated_at = now()
where exists (
  select 1
  from myheritage_vital_status_reconciliation reconciliation
  join public.family_tree_persons membership
    on membership.person_id = reconciliation.person_id
   and membership.project_id = reconciliation.project_id
  where membership.tree_id = tree.id
    and membership.project_id = tree.project_id
);

delete from security_private.family_tree_statistics_cache cache
where exists (
  select 1
  from myheritage_vital_status_reconciliation reconciliation
  join public.family_tree_persons membership
    on membership.person_id = reconciliation.person_id
   and membership.project_id = reconciliation.project_id
  where membership.tree_id = cache.tree_id
    and membership.project_id = cache.project_id
);

commit;
