begin;

-- GEDCOM imports upsert persons in batches.  The projection trigger removes
-- its generated timeline rows before rebuilding them, but the existing
-- project-first indexes cannot serve a lookup that only has person_id.  On a
-- large import that turned every row into a scan of person_timeline_events.
create index if not exists person_timeline_events_persons_projection_person_idx
  on public.person_timeline_events (person_id)
  where metadata ->> 'source' = 'persons_projection';

-- An UPSERT includes all columns in its UPDATE target list even when their
-- values are unchanged.  PostgreSQL UPDATE OF triggers therefore fire for
-- every existing person unless the trigger also compares OLD and NEW.  Keep
-- INSERT projection behavior unconditional, and make UPDATE projection work
-- null-safe and value-sensitive.
drop trigger if exists persons_family_tree_projection_sync_insert on public.persons;
drop trigger if exists persons_family_tree_projection_sync on public.persons;

create trigger persons_family_tree_projection_sync_insert
after insert on public.persons
for each row
execute function public.family_tree_sync_person_projection();

create trigger persons_family_tree_projection_sync
after update of
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
when (
  row(
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
  ) is distinct from row(
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
  )
)
execute function public.family_tree_sync_person_projection();

-- The graph version has the same UPDATE OF behavior.  Avoid serializing every
-- no-op import row on family_trees while still invalidating graph pages for
-- every real display/privacy change.
drop trigger if exists persons_bump_family_tree_graph_versions on public.persons;
create trigger persons_bump_family_tree_graph_versions
after update of
  status,
  gender,
  surname,
  given_name,
  patronymic,
  full_name,
  birth_date,
  birth_year_from,
  birth_year_to,
  death_date,
  death_year_from,
  death_year_to,
  is_living,
  privacy_status
on public.persons
for each row
when (
  row(
    old.status,
    old.gender,
    old.surname,
    old.given_name,
    old.patronymic,
    old.full_name,
    old.birth_date,
    old.birth_year_from,
    old.birth_year_to,
    old.death_date,
    old.death_year_from,
    old.death_year_to,
    old.is_living,
    old.privacy_status
  ) is distinct from row(
    new.status,
    new.gender,
    new.surname,
    new.given_name,
    new.patronymic,
    new.full_name,
    new.birth_date,
    new.birth_year_from,
    new.birth_year_to,
    new.death_date,
    new.death_year_from,
    new.death_year_to,
    new.is_living,
    new.privacy_status
  )
)
execute function public.family_tree_bump_person_graph_versions();

commit;
