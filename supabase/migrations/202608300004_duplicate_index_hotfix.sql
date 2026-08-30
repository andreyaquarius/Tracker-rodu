begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Keep the canonical indexes that are present in the current migration
-- history.  Refuse to remove a same-named index if production has drifted and
-- it is no longer structurally identical to the retained index.
do $$
declare
  duplicate_name text;
  retained_name text;
  duplicate_oid regclass;
  retained_oid regclass;
begin
  for duplicate_name, retained_name in
    select *
    from (
      values
        ('documents_project_status_idx', 'documents_project_review_status_idx'),
        ('task_notifications_project_id_fk_idx', 'task_notifications_project_idx')
    ) as index_pairs(duplicate_name, retained_name)
  loop
    duplicate_oid := to_regclass(format('public.%I', duplicate_name));

    -- A fresh database built from the current migrations may never have had
    -- the orphaned index, so absence is already the desired state.
    if duplicate_oid is null then
      continue;
    end if;

    retained_oid := to_regclass(format('public.%I', retained_name));
    if retained_oid is null then
      raise exception
        'Refusing to drop %, because retained index public.% is missing',
        duplicate_oid,
        retained_name;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_index duplicate_index
      join pg_catalog.pg_class duplicate_class
        on duplicate_class.oid = duplicate_index.indexrelid
      join pg_catalog.pg_index retained_index
        on retained_index.indexrelid = retained_oid
      join pg_catalog.pg_class retained_class
        on retained_class.oid = retained_index.indexrelid
      where duplicate_index.indexrelid = duplicate_oid
        and duplicate_index.indrelid = retained_index.indrelid
        and duplicate_class.relam = retained_class.relam
        and duplicate_index.indnatts = retained_index.indnatts
        and duplicate_index.indnkeyatts = retained_index.indnkeyatts
        and duplicate_index.indisunique = retained_index.indisunique
        and duplicate_index.indisprimary = retained_index.indisprimary
        and duplicate_index.indisexclusion = retained_index.indisexclusion
        and duplicate_index.indnullsnotdistinct = retained_index.indnullsnotdistinct
        and duplicate_index.indkey = retained_index.indkey
        and duplicate_index.indcollation = retained_index.indcollation
        and duplicate_index.indclass = retained_index.indclass
        and duplicate_index.indoption = retained_index.indoption
        and pg_catalog.pg_get_expr(
          duplicate_index.indexprs,
          duplicate_index.indrelid
        ) is not distinct from pg_catalog.pg_get_expr(
          retained_index.indexprs,
          retained_index.indrelid
        )
        and pg_catalog.pg_get_expr(
          duplicate_index.indpred,
          duplicate_index.indrelid
        ) is not distinct from pg_catalog.pg_get_expr(
          retained_index.indpred,
          retained_index.indrelid
        )
        and retained_index.indisvalid
        and retained_index.indisready
        and retained_index.indislive
    ) then
      raise exception
        'Refusing to drop %, because it differs from retained index %',
        duplicate_oid,
        retained_oid;
    end if;
  end loop;
end
$$;

drop index if exists public.documents_project_status_idx;
drop index if exists public.task_notifications_project_id_fk_idx;

commit;
