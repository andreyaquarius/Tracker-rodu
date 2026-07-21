begin;

-- The person card stores a human research status, while the family graph uses
-- a compact evidence scale. Keep the three new human-readable options stable
-- in persons.status and project them without degrading them to "unknown".
create or replace function security_private.family_tree_refresh_person_status_evidence_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  person_evidence_status text;
  person_confidence integer;
begin
  -- UPDATE OF triggers also fire for columns merely present in an UPSERT.
  -- Match the canonical projection trigger's null-safe no-op guard so large
  -- GEDCOM imports do not rewrite the same projection rows unnecessarily.
  if tg_op = 'UPDATE' and row(
    old.status,
    old.surname,
    old.given_name,
    old.patronymic,
    old.full_name,
    old.birth_date,
    old.birth_year_from,
    old.birth_year_to,
    old.birth_place,
    old.marriage_date,
    old.marriage_place,
    old.death_date,
    old.death_year_from,
    old.death_year_to,
    old.death_place,
    old.residence_places
  ) is not distinct from row(
    new.status,
    new.surname,
    new.given_name,
    new.patronymic,
    new.full_name,
    new.birth_date,
    new.birth_year_from,
    new.birth_year_to,
    new.birth_place,
    new.marriage_date,
    new.marriage_place,
    new.death_date,
    new.death_year_from,
    new.death_year_to,
    new.death_place,
    new.residence_places
  ) then
    return new;
  end if;

  person_evidence_status := case new.status
    when 'доведена' then 'proven'
    when 'відома особисто' then 'proven'
    when 'відома документально' then 'proven'
    when 'частково доведена' then 'likely'
    when 'відома з переказів' then 'likely'
    when 'сумнівна' then 'disputed'
    when 'спростована' then 'disproven'
    else 'unknown'
  end;
  person_confidence := public.family_tree_confidence_for_evidence(person_evidence_status);

  update public.person_names name
  set evidence_status = person_evidence_status,
      confidence = person_confidence,
      updated_at = pg_catalog.now()
  where name.project_id = new.project_id
    and name.person_id = new.id
    and name.is_primary;

  update public.person_timeline_events event
  set evidence_status = person_evidence_status,
      confidence = person_confidence,
      updated_at = pg_catalog.now()
  where event.project_id = new.project_id
    and event.person_id = new.id
    and event.metadata ->> 'source' = 'persons_projection';

  return new;
end;
$function$;

revoke all on function security_private.family_tree_refresh_person_status_evidence_projection()
  from public, anon, authenticated, service_role;

drop trigger if exists persons_status_evidence_projection_sync on public.persons;
create trigger persons_status_evidence_projection_sync
after insert or update of
  status,
  surname,
  given_name,
  patronymic,
  full_name,
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
when (new.status in (
  'відома особисто',
  'відома з переказів',
  'відома документально'
))
execute function security_private.family_tree_refresh_person_status_evidence_projection();

-- Bring projections created before this migration to the same semantics.
update public.person_names name
set evidence_status = case person.status
      when 'доведена' then 'proven'
      when 'відома особисто' then 'proven'
      when 'відома документально' then 'proven'
      when 'частково доведена' then 'likely'
      when 'відома з переказів' then 'likely'
      when 'сумнівна' then 'disputed'
      when 'спростована' then 'disproven'
      else 'unknown'
    end,
    confidence = public.family_tree_confidence_for_evidence(case person.status
      when 'доведена' then 'proven'
      when 'відома особисто' then 'proven'
      when 'відома документально' then 'proven'
      when 'частково доведена' then 'likely'
      when 'відома з переказів' then 'likely'
      when 'сумнівна' then 'disputed'
      when 'спростована' then 'disproven'
      else 'unknown'
    end),
    updated_at = pg_catalog.now()
from public.persons person
where person.id = name.person_id
  and person.project_id = name.project_id
  and name.is_primary
  and person.status in (
    'відома особисто',
    'відома з переказів',
    'відома документально'
  );

update public.person_timeline_events event
set evidence_status = case person.status
      when 'відома особисто' then 'proven'
      when 'відома документально' then 'proven'
      when 'відома з переказів' then 'likely'
      else event.evidence_status
    end,
    confidence = public.family_tree_confidence_for_evidence(case person.status
      when 'відома особисто' then 'proven'
      when 'відома документально' then 'proven'
      when 'відома з переказів' then 'likely'
      else event.evidence_status
    end),
    updated_at = pg_catalog.now()
from public.persons person
where person.id = event.person_id
  and person.project_id = event.project_id
  and event.metadata ->> 'source' = 'persons_projection'
  and person.status in (
    'відома особисто',
    'відома з переказів',
    'відома документально'
  );

commit;
