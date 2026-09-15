begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Retract derived values while the finding still exists. FK SET NULL alone
-- cannot clean JSON events or the ownership ledger in persons.custom_fields.
-- Reuse the unlink rules: independent edits and corroborating sources survive.
create or replace function security_private.finding_facts_before_delete_v1()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, security_private, pg_temp as $$
begin
  perform security_private.detach_obsolete_finding_facts_v1(
    old.project_id, old.id, '{}'::uuid[], '{}'::uuid[]);
  return old;
end;
$$;
revoke all on function security_private.finding_facts_before_delete_v1()
  from public, anon, authenticated, service_role;
create trigger findings_retract_owned_facts
  before delete on public.findings for each row
  execute function security_private.finding_facts_before_delete_v1();

-- The client needs the former profile IDs to refresh their local snapshots
-- immediately. Compute them and delete the source in one guarded transaction.
create or replace function security_private.delete_finding_with_facts_v1(p_project_id uuid, p_finding_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, security_private, pg_temp
set lock_timeout = '2s'
set statement_timeout = '8s' as $$
declare source public.findings%rowtype; affected uuid[];
begin
  if auth.uid() is null or not public.can_edit_project(p_project_id) then
    raise exception 'PROJECT_EDIT_REQUIRED' using errcode='42501';
  end if;
  select * into source from public.findings
    where project_id=p_project_id and id=p_finding_id for update;
  if not found then return jsonb_build_object('personIds','[]'::jsonb,'deleted',false); end if;
  select coalesce(array_agg(p.id order by p.id),'{}'::uuid[]) into affected
  from public.persons p where p.project_id=p_project_id and (
    (p.custom_fields ? '__trackerRoduFindingFacts'
      and (p.custom_fields->'__trackerRoduFindingFacts') ? p_finding_id::text)
    or exists(select 1 from public.finding_participants fp
      where fp.project_id=p_project_id and fp.finding_id=p_finding_id and fp.person_id=p.id)
    or (source.custom_fields #> '{__trackerRoduFindingMeta,personIds}') ? p.id::text
  );
  delete from public.findings where project_id=p_project_id and id=p_finding_id;
  return jsonb_build_object('personIds',to_jsonb(affected),'deleted',true);
end;
$$;
create or replace function public.delete_finding_with_facts_v1(p_project_id uuid, p_finding_id uuid)
returns jsonb language sql security invoker set search_path = '' as $$
  select security_private.delete_finding_with_facts_v1(p_project_id,p_finding_id);
$$;
revoke all on function security_private.delete_finding_with_facts_v1(uuid,uuid),
  public.delete_finding_with_facts_v1(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function security_private.delete_finding_with_facts_v1(uuid,uuid),
  public.delete_finding_with_facts_v1(uuid,uuid) to authenticated;

-- Repair only proven orphans from previously deleted findings, identified by
-- explicit source ownership. No inferred matches, no deletion of people,
-- family groups, manual notes, attachments or historical source documents.
do $$
declare orphan record;
begin
  for orphan in
    with sources as (
      select p.project_id, entry.key as finding_id
      from public.persons p
      cross join lateral jsonb_each(case when jsonb_typeof(p.custom_fields->'__trackerRoduFindingFacts')='object'
        then p.custom_fields->'__trackerRoduFindingFacts' else '{}'::jsonb end) entry
      where p.custom_fields ? '__trackerRoduFindingFacts'
      union
      select pr.project_id, entry.key
      from public.partner_relationships pr
      cross join lateral jsonb_each(case when jsonb_typeof(pr.metadata->'findingFacts')='object'
        then pr.metadata->'findingFacts' else '{}'::jsonb end) entry
      where pr.metadata ? 'findingFacts'
    )
    select project_id, finding_id::uuid as finding_id from sources s
    where finding_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and not exists(select 1 from public.findings f where f.project_id=s.project_id and f.id::text=s.finding_id)
    order by project_id, finding_id
  loop
    perform security_private.detach_obsolete_finding_facts_v1(
      orphan.project_id, orphan.finding_id, '{}'::uuid[], '{}'::uuid[]);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
commit;
