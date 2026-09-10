begin;

-- UPSERT already batches records. Do not repeat the full social-context
-- projection when a replay changes only updated_at. The source UPDATE and its
-- RETURNING result still execute; no user data, RLS, or source trigger is lost.
create or replace function security_private.sync_finding_context_after_update_v1()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct affected.finding_id, affected.project_id
    from old_rows old_row full join new_rows new_row on new_row.id = old_row.id
    cross join lateral (values
      (old_row.finding_id, old_row.project_id), (new_row.finding_id, new_row.project_id)
    ) as affected(finding_id, project_id)
    where (to_jsonb(new_row) - 'updated_at') is distinct from (to_jsonb(old_row) - 'updated_at')
      and affected.finding_id is not null and affected.project_id is not null
  loop
    perform security_private.sync_finding_context_relations_v1(changed.finding_id, changed.project_id);
  end loop;
  return null;
end
$function$;

create or replace function security_private.sync_finding_context_after_finding_update_v1()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct updated.id, updated.project_id
    from updated_findings updated
    left join previous_findings previous on previous.id = updated.id
    where (to_jsonb(updated) - 'updated_at') is distinct from (to_jsonb(previous) - 'updated_at')
  loop
    perform security_private.sync_finding_context_relations_v1(changed.id, changed.project_id);
  end loop;
  return null;
end
$function$;

drop trigger if exists findings_80_context_sync_update on public.findings;
create trigger findings_80_context_sync_update after update on public.findings
referencing old table as previous_findings new table as updated_findings
for each statement execute function security_private.sync_finding_context_after_finding_update_v1();

revoke all on function security_private.sync_finding_context_after_update_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_finding_update_v1()
  from public, anon, authenticated, service_role;
commit;
