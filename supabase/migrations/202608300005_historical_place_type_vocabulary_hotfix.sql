begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- KATOTTG category T and the historical-place UI both emit this controlled
-- code.  The foundation seed omitted it, so the otherwise valid assignment
-- was rejected by place_type_assignments_place_type_code_fkey.
insert into public.place_types (
  code,
  label_uk,
  description,
  sort_order,
  is_active
) values (
  'urban_settlement',
  'селище',
  'Населений пункт типу «селище», зокрема історичне селище міського типу.',
  25,
  true
)
on conflict (code) do update set
  label_uk = excluded.label_uk,
  description = excluded.description,
  sort_order = excluded.sort_order,
  is_active = true,
  updated_at = now();

commit;
