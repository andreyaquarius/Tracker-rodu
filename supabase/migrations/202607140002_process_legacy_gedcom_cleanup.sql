begin;

create or replace function private.delete_legacy_gedcom_cleanup_phase(
  target_job_id uuid,
  target_phase text,
  batch_size integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  target_project_id uuid;
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 250), 500));
  affected_count integer := 0;
begin
  select job.project_id into target_project_id
  from private.legacy_gedcom_cleanup_jobs job
  where job.id = target_job_id;
  if target_project_id is null then
    raise exception 'LEGACY_GEDCOM_CLEANUP_NOT_FOUND' using errcode = '22023';
  end if;

  case target_phase
    when 'activity_log' then
      with target_rows as (
        select log.ctid
        from public.activity_log log
        where log.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and entity.entity_id = log.entity_id
              and (
                (lower(log.entity_type) in ('person', 'persons') and entity.entity_type = 'person')
                or (lower(log.entity_type) in ('finding', 'findings') and entity.entity_type = 'finding')
                or (lower(log.entity_type) in ('document', 'documents') and entity.entity_type = 'document')
                or (lower(log.entity_type) in ('attachment', 'attachments') and entity.entity_type = 'attachment')
                or (lower(log.entity_type) in ('person_relation', 'person_relations') and entity.entity_type = 'person_relation')
                or (lower(log.entity_type) in ('association_relationship', 'association_relationships') and entity.entity_type = 'association_relationship')
                or (lower(log.entity_type) in ('parent_child_relationship', 'parent_child_relationships') and entity.entity_type = 'parent_child_relationship')
                or (lower(log.entity_type) in ('partner_relationship', 'partner_relationships') and entity.entity_type = 'partner_relationship')
                or (lower(log.entity_type) in ('gedcom_import_batch', 'gedcom_import_batches') and entity.entity_type = 'gedcom_import_batch')
              )
          )
        order by log.id
        limit safe_batch_size
      )
      delete from public.activity_log log
      using target_rows target
      where log.ctid = target.ctid;

    when 'record_links' then
      with target_rows as (
        select link.ctid
        from public.record_links link
        where link.project_id = target_project_id
          and (
            exists (
              select 1 from private.legacy_gedcom_cleanup_entities entity
              where entity.job_id = target_job_id
                and entity.entity_id = link.source_id
                and (
                  (lower(link.source_type) in ('person', 'persons') and entity.entity_type = 'person')
                  or (lower(link.source_type) in ('finding', 'findings') and entity.entity_type = 'finding')
                  or (lower(link.source_type) in ('document', 'documents') and entity.entity_type = 'document')
                  or (lower(link.source_type) in ('attachment', 'attachments') and entity.entity_type = 'attachment')
                  or (lower(link.source_type) in ('person_relation', 'person_relations') and entity.entity_type = 'person_relation')
                  or (lower(link.source_type) in ('association_relationship', 'association_relationships') and entity.entity_type = 'association_relationship')
                  or (lower(link.source_type) in ('parent_child_relationship', 'parent_child_relationships') and entity.entity_type = 'parent_child_relationship')
                  or (lower(link.source_type) in ('partner_relationship', 'partner_relationships') and entity.entity_type = 'partner_relationship')
                  or (lower(link.source_type) in ('gedcom_import_batch', 'gedcom_import_batches') and entity.entity_type = 'gedcom_import_batch')
                )
            )
            or exists (
              select 1 from private.legacy_gedcom_cleanup_entities entity
              where entity.job_id = target_job_id
                and entity.entity_id = link.target_id
                and (
                  (lower(link.target_type) in ('person', 'persons') and entity.entity_type = 'person')
                  or (lower(link.target_type) in ('finding', 'findings') and entity.entity_type = 'finding')
                  or (lower(link.target_type) in ('document', 'documents') and entity.entity_type = 'document')
                  or (lower(link.target_type) in ('attachment', 'attachments') and entity.entity_type = 'attachment')
                  or (lower(link.target_type) in ('person_relation', 'person_relations') and entity.entity_type = 'person_relation')
                  or (lower(link.target_type) in ('association_relationship', 'association_relationships') and entity.entity_type = 'association_relationship')
                  or (lower(link.target_type) in ('parent_child_relationship', 'parent_child_relationships') and entity.entity_type = 'parent_child_relationship')
                  or (lower(link.target_type) in ('partner_relationship', 'partner_relationships') and entity.entity_type = 'partner_relationship')
                  or (lower(link.target_type) in ('gedcom_import_batch', 'gedcom_import_batches') and entity.entity_type = 'gedcom_import_batch')
                )
            )
          )
        order by link.id
        limit safe_batch_size
      )
      delete from public.record_links link
      using target_rows target
      where link.ctid = target.ctid;

    when 'hypothesis_links' then
      with target_rows as (
        select link.ctid
        from public.hypothesis_links link
        where link.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and entity.entity_id = link.target_id
              and (
                (link.target_type = 'person' and entity.entity_type = 'person')
                or (link.target_type = 'finding' and entity.entity_type = 'finding')
                or (link.target_type = 'document' and entity.entity_type = 'document')
              )
          )
        order by link.hypothesis_id, link.target_type, link.target_id
        limit safe_batch_size
      )
      delete from public.hypothesis_links link
      using target_rows target
      where link.ctid = target.ctid;

    when 'attachments' then
      with target_rows as (
        select attachment.ctid
        from public.attachments attachment
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'attachment'
         and entity.entity_id = attachment.id
        where attachment.project_id = target_project_id
          and (
            attachment.storage_bucket <> 'project-attachments'
            or exists (
              select 1
              from private.legacy_gedcom_cleanup_storage_objects object
              where object.job_id = target_job_id
                and object.attachment_id = attachment.id
                and object.deleted_at is not null
            )
          )
        order by attachment.id
        limit safe_batch_size
      )
      delete from public.attachments attachment
      using target_rows target
      where attachment.ctid = target.ctid;

    when 'gedcom_xref_maps' then
      with target_rows as (
        select xref.ctid
        from public.gedcom_xref_maps xref
        where xref.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and entity.entity_id = xref.internal_id
              and (
                (xref.internal_table in ('person', 'persons') and entity.entity_type = 'person')
                or (xref.internal_table in ('finding', 'findings') and entity.entity_type = 'finding')
                or (xref.internal_table in ('document', 'documents') and entity.entity_type = 'document')
                or (xref.internal_table = 'gedcom_import_batches' and entity.entity_type = 'gedcom_import_batch')
                or (xref.internal_table in ('person_relation', 'person_relations') and entity.entity_type = 'person_relation')
                or (xref.internal_table in ('association_relationship', 'association_relationships') and entity.entity_type = 'association_relationship')
                or (xref.internal_table in ('parent_child_relationship', 'parent_child_relationships') and entity.entity_type = 'parent_child_relationship')
                or (xref.internal_table in ('partner_relationship', 'partner_relationships') and entity.entity_type = 'partner_relationship')
              )
          )
        order by xref.id
        limit safe_batch_size
      )
      delete from public.gedcom_xref_maps xref
      using target_rows target
      where xref.ctid = target.ctid;

    when 'family_tree_merge_history' then
      with target_rows as (
        select history.ctid
        from public.family_tree_merge_history history
        where history.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id in (history.survivor_person_id, history.merged_person_id)
          )
        order by history.id
        limit safe_batch_size
      )
      delete from public.family_tree_merge_history history
      using target_rows target
      where history.ctid = target.ctid;

    when 'person_relations' then
      with target_rows as (
        select relation.ctid
        from public.person_relations relation
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'person_relation'
         and entity.entity_id = relation.id
        where relation.project_id = target_project_id
        order by relation.id
        limit safe_batch_size
      )
      delete from public.person_relations relation
      using target_rows target
      where relation.ctid = target.ctid;

    when 'association_relationships' then
      with target_rows as (
        select relation.ctid
        from public.association_relationships relation
        where relation.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id in (relation.person_a_id, relation.person_b_id)
          )
        order by relation.id
        limit safe_batch_size
      )
      delete from public.association_relationships relation
      using target_rows target
      where relation.ctid = target.ctid;

    when 'parent_child_relationships' then
      with target_rows as (
        select relation.ctid
        from public.parent_child_relationships relation
        where relation.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id in (relation.parent_id, relation.child_id)
          )
        order by relation.id
        limit safe_batch_size
      )
      delete from public.parent_child_relationships relation
      using target_rows target
      where relation.ctid = target.ctid;

    when 'partner_relationships' then
      with target_rows as (
        select relation.ctid
        from public.partner_relationships relation
        where relation.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id in (relation.person_a_id, relation.person_b_id)
          )
        order by relation.id
        limit safe_batch_size
      )
      delete from public.partner_relationships relation
      using target_rows target
      where relation.ctid = target.ctid;

    when 'family_group_members' then
      with target_rows as (
        select member.ctid
        from public.family_group_members member
        where member.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = member.person_id
          )
        order by member.family_group_id, member.person_id, member.member_role
        limit safe_batch_size
      )
      delete from public.family_group_members member
      using target_rows target
      where member.ctid = target.ctid;

    when 'tree_layout_positions' then
      with target_rows as (
        select position.ctid
        from public.tree_layout_positions position
        where position.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = position.person_id
          )
        order by position.id
        limit safe_batch_size
      )
      delete from public.tree_layout_positions position
      using target_rows target
      where position.ctid = target.ctid;

    when 'family_tree_research_issues' then
      with target_rows as (
        select issue.ctid
        from public.family_tree_research_issues issue
        where issue.project_id = target_project_id
          and (
            exists (
              select 1 from private.legacy_gedcom_cleanup_entities person
              where person.job_id = target_job_id
                and person.entity_type = 'person'
                and person.entity_id = issue.person_id
            )
            or exists (
              select 1 from private.legacy_gedcom_cleanup_entities entity
              where entity.job_id = target_job_id
                and entity.entity_id = issue.relationship_id
                and (
                  (lower(issue.relationship_table) in ('person_relation', 'person_relations') and entity.entity_type = 'person_relation')
                  or (lower(issue.relationship_table) in ('association_relationship', 'association_relationships') and entity.entity_type = 'association_relationship')
                  or (lower(issue.relationship_table) in ('parent_child_relationship', 'parent_child_relationships') and entity.entity_type = 'parent_child_relationship')
                  or (lower(issue.relationship_table) in ('partner_relationship', 'partner_relationships') and entity.entity_type = 'partner_relationship')
                )
            )
          )
        order by issue.id
        limit safe_batch_size
      )
      delete from public.family_tree_research_issues issue
      using target_rows target
      where issue.ctid = target.ctid;

    when 'person_timeline_events' then
      with target_rows as (
        select event.ctid
        from public.person_timeline_events event
        where event.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = event.person_id
          )
        order by event.id
        limit safe_batch_size
      )
      delete from public.person_timeline_events event
      using target_rows target
      where event.ctid = target.ctid;

    when 'person_names' then
      with target_rows as (
        select name.ctid
        from public.person_names name
        where name.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = name.person_id
          )
        order by name.id
        limit safe_batch_size
      )
      delete from public.person_names name
      using target_rows target
      where name.ctid = target.ctid;

    when 'task_persons' then
      with target_rows as (
        select task_person.ctid
        from public.task_persons task_person
        where task_person.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = task_person.person_id
          )
        order by task_person.task_id, task_person.person_id
        limit safe_batch_size
      )
      delete from public.task_persons task_person
      using target_rows target
      where task_person.ctid = target.ctid;

    when 'archive_request_persons' then
      with target_rows as (
        select request_person.ctid
        from public.archive_request_persons request_person
        where request_person.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = request_person.person_id
          )
        order by request_person.archive_request_id, request_person.person_id
        limit safe_batch_size
      )
      delete from public.archive_request_persons request_person
      using target_rows target
      where request_person.ctid = target.ctid;

    when 'finding_participants' then
      with target_rows as (
        select participant.ctid
        from public.finding_participants participant
        where participant.project_id = target_project_id
          and (
            exists (
              select 1 from private.legacy_gedcom_cleanup_entities person
              where person.job_id = target_job_id
                and person.entity_type = 'person'
                and person.entity_id = participant.person_id
            )
            or exists (
              select 1 from private.legacy_gedcom_cleanup_entities finding
              where finding.job_id = target_job_id
                and finding.entity_type = 'finding'
                and finding.entity_id = participant.finding_id
            )
          )
        order by participant.id
        limit safe_batch_size
      )
      delete from public.finding_participants participant
      using target_rows target
      where participant.ctid = target.ctid;

    when 'parent_sets_for_people' then
      with target_rows as (
        select parent_set.ctid
        from public.parent_sets parent_set
        where parent_set.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = parent_set.child_id
          )
        order by parent_set.id
        limit safe_batch_size
      )
      delete from public.parent_sets parent_set
      using target_rows target
      where parent_set.ctid = target.ctid;

    when 'family_tree_persons' then
      with target_rows as (
        select member.ctid
        from public.family_tree_persons member
        where member.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = member.person_id
          )
        order by member.tree_id, member.person_id
        limit safe_batch_size
      )
      delete from public.family_tree_persons member
      using target_rows target
      where member.ctid = target.ctid;

    when 'family_tree_roots' then
      with target_rows as (
        select tree.id
        from public.family_trees tree
        where tree.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = tree.root_person_id
          )
        order by tree.id
        limit safe_batch_size
      )
      update public.family_trees tree
      set root_person_id = (
            select member.person_id
            from public.family_tree_persons member
            where member.project_id = target_project_id
              and member.tree_id = tree.id
              and not exists (
                select 1 from private.legacy_gedcom_cleanup_entities person
                where person.job_id = target_job_id
                  and person.entity_type = 'person'
                  and person.entity_id = member.person_id
              )
            order by case member.member_role when 'root' then 0 else 1 end,
                     member.display_order,
                     member.person_id
            limit 1
          ),
          updated_at = clock_timestamp()
      from target_rows target
      where tree.id = target.id;

    when 'family_group_partner_refs' then
      with target_rows as (
        select family_group.id
        from public.family_groups family_group
        where family_group.project_id = target_project_id
          and exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id in (
                family_group.primary_partner_1_id,
                family_group.primary_partner_2_id
              )
          )
        order by family_group.id
        limit safe_batch_size
      )
      update public.family_groups family_group
      set primary_partner_1_id = case when exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = family_group.primary_partner_1_id
          ) then null else family_group.primary_partner_1_id end,
          primary_partner_2_id = case when exists (
            select 1 from private.legacy_gedcom_cleanup_entities person
            where person.job_id = target_job_id
              and person.entity_type = 'person'
              and person.entity_id = family_group.primary_partner_2_id
          ) then null else family_group.primary_partner_2_id end,
          updated_at = clock_timestamp()
      from target_rows target
      where family_group.id = target.id;

    when 'findings' then
      with target_rows as (
        select finding.ctid
        from public.findings finding
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'finding'
         and entity.entity_id = finding.id
        where finding.project_id = target_project_id
        order by finding.id
        limit safe_batch_size
      )
      delete from public.findings finding
      using target_rows target
      where finding.ctid = target.ctid;

    when 'documents' then
      with target_rows as (
        select document.ctid
        from public.documents document
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'document'
         and entity.entity_id = document.id
        where document.project_id = target_project_id
        order by document.id
        limit safe_batch_size
      )
      delete from public.documents document
      using target_rows target
      where document.ctid = target.ctid;

    when 'persons' then
      with target_rows as (
        select person.ctid
        from public.persons person
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'person'
         and entity.entity_id = person.id
        where person.project_id = target_project_id
        order by person.id
        limit safe_batch_size
      )
      delete from public.persons person
      using target_rows target
      where person.ctid = target.ctid;

    when 'orphan_parent_sets' then
      with target_rows as (
        select parent_set.ctid
        from public.parent_sets parent_set
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'parent_set'
         and entity.entity_id = parent_set.id
        where parent_set.project_id = target_project_id
          and not exists (
            select 1 from public.parent_child_relationships relation
            where relation.parent_set_id = parent_set.id
          )
        order by parent_set.id
        limit safe_batch_size
      )
      delete from public.parent_sets parent_set
      using target_rows target
      where parent_set.ctid = target.ctid;

    when 'orphan_family_groups' then
      with target_rows as (
        select family_group.ctid
        from public.family_groups family_group
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'family_group'
         and entity.entity_id = family_group.id
        where family_group.project_id = target_project_id
          and family_group.primary_partner_1_id is null
          and family_group.primary_partner_2_id is null
          and not exists (
            select 1 from public.family_group_members member
            where member.family_group_id = family_group.id
          )
          and not exists (
            select 1 from public.partner_relationships relation
            where relation.family_group_id = family_group.id
          )
          and not exists (
            select 1 from public.parent_sets parent_set
            where parent_set.family_group_id = family_group.id
          )
          and not exists (
            select 1 from public.parent_child_relationships relation
            where relation.family_group_id = family_group.id
          )
        order by family_group.id
        limit safe_batch_size
      )
      delete from public.family_groups family_group
      using target_rows target
      where family_group.ctid = target.ctid;

    -- parent_set/family_group snapshot rows are repair candidates, not
    -- necessarily cleanup-owned rows.  Their polymorphic metadata must remain
    -- when a mixed-source container survives.  Remove it only after the orphan
    -- phases prove that the concrete container row was actually deleted.
    when 'deleted_container_activity_log' then
      with target_rows as (
        select log.ctid
        from public.activity_log log
        where log.project_id = target_project_id
          and exists (
            select 1
            from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and entity.entity_id = log.entity_id
              and (
                (
                  entity.entity_type = 'parent_set'
                  and lower(log.entity_type) in ('parent_set', 'parent_sets')
                  and not exists (
                    select 1 from public.parent_sets parent_set
                    where parent_set.id = entity.entity_id
                  )
                )
                or (
                  entity.entity_type = 'family_group'
                  and lower(log.entity_type) in ('family_group', 'family_groups')
                  and not exists (
                    select 1 from public.family_groups family_group
                    where family_group.id = entity.entity_id
                  )
                )
              )
          )
        order by log.id
        limit safe_batch_size
      )
      delete from public.activity_log log
      using target_rows target
      where log.ctid = target.ctid;

    when 'deleted_container_record_links' then
      with target_rows as (
        select link.ctid
        from public.record_links link
        where link.project_id = target_project_id
          and exists (
            select 1
            from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and (
                (
                  entity.entity_type = 'parent_set'
                  and not exists (
                    select 1 from public.parent_sets parent_set
                    where parent_set.id = entity.entity_id
                  )
                  and (
                    (link.source_id = entity.entity_id and lower(link.source_type) in ('parent_set', 'parent_sets'))
                    or (link.target_id = entity.entity_id and lower(link.target_type) in ('parent_set', 'parent_sets'))
                  )
                )
                or (
                  entity.entity_type = 'family_group'
                  and not exists (
                    select 1 from public.family_groups family_group
                    where family_group.id = entity.entity_id
                  )
                  and (
                    (link.source_id = entity.entity_id and lower(link.source_type) in ('family_group', 'family_groups'))
                    or (link.target_id = entity.entity_id and lower(link.target_type) in ('family_group', 'family_groups'))
                  )
                )
              )
          )
        order by link.id
        limit safe_batch_size
      )
      delete from public.record_links link
      using target_rows target
      where link.ctid = target.ctid;

    when 'deleted_container_xrefs' then
      with target_rows as (
        select xref.ctid
        from public.gedcom_xref_maps xref
        where xref.project_id = target_project_id
          and exists (
            select 1
            from private.legacy_gedcom_cleanup_entities entity
            where entity.job_id = target_job_id
              and entity.entity_id = xref.internal_id
              and (
                (
                  entity.entity_type = 'parent_set'
                  and xref.internal_table in ('parent_set', 'parent_sets')
                  and not exists (
                    select 1 from public.parent_sets parent_set
                    where parent_set.id = entity.entity_id
                  )
                )
                or (
                  entity.entity_type = 'family_group'
                  and xref.internal_table in ('family_group', 'family_groups')
                  and not exists (
                    select 1 from public.family_groups family_group
                    where family_group.id = entity.entity_id
                  )
                )
              )
          )
        order by xref.id
        limit safe_batch_size
      )
      delete from public.gedcom_xref_maps xref
      using target_rows target
      where xref.ctid = target.ctid;

    when 'gedcom_import_batches' then
      with target_rows as (
        select batch.ctid
        from public.gedcom_import_batches batch
        join private.legacy_gedcom_cleanup_entities entity
          on entity.job_id = target_job_id
         and entity.entity_type = 'gedcom_import_batch'
         and entity.entity_id = batch.id
        where batch.project_id = target_project_id
        order by batch.id
        limit safe_batch_size
      )
      delete from public.gedcom_import_batches batch
      using target_rows target
      where batch.ctid = target.ctid;

    when 'finalize_trees' then
      with target_rows as (
        select entity.entity_id
        from private.legacy_gedcom_cleanup_entities entity
        where entity.job_id = target_job_id
          and entity.entity_type = 'family_tree'
          and entity.processed_at is null
        order by entity.entity_id
        limit safe_batch_size
      ), updated_trees as (
        update public.family_trees tree
        set graph_version = tree.graph_version + 1,
            updated_at = clock_timestamp()
        from target_rows target
        where tree.project_id = target_project_id
          and tree.id = target.entity_id
        returning tree.id
      )
      update private.legacy_gedcom_cleanup_entities entity
      set processed_at = clock_timestamp()
      where entity.job_id = target_job_id
        and entity.entity_type = 'family_tree'
        and entity.entity_id in (select target.entity_id from target_rows target)
        and entity.processed_at is null;

    else
      raise exception 'LEGACY_GEDCOM_CLEANUP_PHASE_INVALID:%', target_phase
        using errcode = '22023';
  end case;

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

revoke execute on function private.delete_legacy_gedcom_cleanup_phase(uuid, text, integer)
  from public, anon, authenticated;

create or replace function private.legacy_gedcom_cleanup_has_remaining_rows(
  target_job_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  select
    exists (
      select 1 from public.persons row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'person'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.findings row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'finding'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.documents row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'document'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.attachments row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'attachment'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.person_relations row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'person_relation'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.association_relationships row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'association_relationship'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.parent_child_relationships row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'parent_child_relationship'
       and entity.entity_id = row.id
    )
    or exists (
      select 1 from public.partner_relationships row
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id and entity.entity_type = 'partner_relationship'
       and entity.entity_id = row.id
    )
    or exists (
      select 1
      from public.hypothesis_links link
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id
       and entity.entity_id = link.target_id
       and (
         (link.target_type = 'person' and entity.entity_type = 'person')
         or (link.target_type = 'finding' and entity.entity_type = 'finding')
         or (link.target_type = 'document' and entity.entity_type = 'document')
       )
    )
    or exists (
      select 1
      from public.activity_log log
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id
       and entity.entity_id = log.entity_id
       and (
         entity.entity_type not in ('family_tree', 'parent_set', 'family_group')
         or (
           entity.entity_type = 'parent_set'
           and not exists (
             select 1 from public.parent_sets parent_set
             where parent_set.id = entity.entity_id
           )
         )
         or (
           entity.entity_type = 'family_group'
           and not exists (
             select 1 from public.family_groups family_group
             where family_group.id = entity.entity_id
           )
         )
       )
       and lower(log.entity_type) = any(
         case entity.entity_type
           when 'gedcom_import_batch' then array['gedcom_import_batch', 'gedcom_import_batches']
           else array[entity.entity_type, entity.entity_type || 's']
         end
       )
    )
    or exists (
      select 1
      from public.record_links link
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id
       and (
         entity.entity_type not in ('family_tree', 'parent_set', 'family_group')
         or (
           entity.entity_type = 'parent_set'
           and not exists (
             select 1 from public.parent_sets parent_set
             where parent_set.id = entity.entity_id
           )
         )
         or (
           entity.entity_type = 'family_group'
           and not exists (
             select 1 from public.family_groups family_group
             where family_group.id = entity.entity_id
           )
         )
       )
       and (
         (entity.entity_id = link.source_id and lower(link.source_type) = any(
           case entity.entity_type
             when 'gedcom_import_batch' then array['gedcom_import_batch', 'gedcom_import_batches']
             else array[entity.entity_type, entity.entity_type || 's']
           end
         ))
         or (entity.entity_id = link.target_id and lower(link.target_type) = any(
           case entity.entity_type
             when 'gedcom_import_batch' then array['gedcom_import_batch', 'gedcom_import_batches']
             else array[entity.entity_type, entity.entity_type || 's']
           end
         ))
       )
    )
    or exists (
      select 1
      from public.gedcom_xref_maps xref
      join private.legacy_gedcom_cleanup_entities entity
        on entity.job_id = target_job_id
       and (
         entity.entity_type not in ('family_tree', 'parent_set', 'family_group')
         or (
           entity.entity_type = 'parent_set'
           and not exists (
             select 1 from public.parent_sets parent_set
             where parent_set.id = entity.entity_id
           )
         )
         or (
           entity.entity_type = 'family_group'
           and not exists (
             select 1 from public.family_groups family_group
             where family_group.id = entity.entity_id
           )
         )
       )
       and entity.entity_id = xref.internal_id
       and xref.internal_table = any(
         case entity.entity_type
           when 'gedcom_import_batch' then array['gedcom_import_batch', 'gedcom_import_batches']
           else array[entity.entity_type, entity.entity_type || 's']
         end
       )
    );
$$;

revoke execute on function private.legacy_gedcom_cleanup_has_remaining_rows(uuid)
  from public, anon, authenticated;

create or replace function public.process_legacy_gedcom_cleanup(
  target_job_id uuid,
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
set statement_timeout = '10s'
as $$
declare
  cleanup_job private.legacy_gedcom_cleanup_jobs%rowtype;
  phases text[] := private.legacy_gedcom_cleanup_phase_names();
  phase_count integer := cardinality(phases);
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 250), 500));
  current_phase text;
  affected_count integer;
  remaining_count integer;
  preserved_count integer;
  preserved_checksum text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null then
    raise exception 'LEGACY_GEDCOM_CLEANUP_JOB_ID_REQUIRED' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_job_id::text, 7420)
  );
  select job.* into cleanup_job
  from private.legacy_gedcom_cleanup_jobs job
  where job.id = target_job_id
  for update;

  if cleanup_job.id is null then
    raise exception 'LEGACY_GEDCOM_CLEANUP_NOT_FOUND' using errcode = '22023';
  end if;
  if cleanup_job.status in ('completed', 'paused') then
    return private.legacy_gedcom_cleanup_payload(cleanup_job.id);
  end if;

  update private.legacy_gedcom_cleanup_jobs
  set status = 'running', error = null, updated_at = clock_timestamp()
  where id = cleanup_job.id;
  perform pg_catalog.set_config('app.project_deletion', 'on', true);
  perform pg_catalog.set_config('app.legacy_gedcom_cleanup', 'on', true);

  begin
    loop
      if cleanup_job.phase_index >= phase_count then
        select count(*)::integer into remaining_count
        from public.persons person
        where person.project_id = cleanup_job.project_id
          and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
          and person.custom_fields ->> '__gedcomImportSourceKey' = cleanup_job.source_key;
        if remaining_count <> 0
           or cleanup_job.deleted_person_count <> cleanup_job.expected_person_count then
          raise exception
            'LEGACY_GEDCOM_CLEANUP_FINAL_COUNT_MISMATCH:remaining=%,deleted=%,expected=%',
            remaining_count, cleanup_job.deleted_person_count,
            cleanup_job.expected_person_count
            using errcode = '55000';
        end if;
        select count(*)::integer,
               md5(coalesce(string_agg(person.id::text, ',' order by person.id), ''))
        into preserved_count, preserved_checksum
        from public.persons person
        where person.project_id = cleanup_job.project_id
          and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '')
              <> cleanup_job.source_key;
        if preserved_count <> cleanup_job.preserved_person_count
           or preserved_checksum <> cleanup_job.preserved_person_checksum then
          raise exception
            'LEGACY_GEDCOM_CLEANUP_PRESERVE_INVARIANT_FAILED:count=%,expected_count=%,checksum=%,expected_checksum=%',
            preserved_count, cleanup_job.preserved_person_count,
            preserved_checksum, cleanup_job.preserved_person_checksum
            using errcode = '55000';
        end if;
        if exists (
          select 1 from public.findings finding
          where finding.project_id = cleanup_job.project_id
            and coalesce(finding.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
            and finding.custom_fields ->> '__gedcomImportSourceKey' = cleanup_job.source_key
        ) or exists (
          select 1 from public.documents document
          where document.project_id = cleanup_job.project_id
            and coalesce(document.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
            and document.custom_fields ->> '__gedcomImportSourceKey' = cleanup_job.source_key
        ) then
          raise exception 'LEGACY_GEDCOM_CLEANUP_SOURCE_ROWS_REMAIN' using errcode = '55000';
        end if;
        if private.legacy_gedcom_cleanup_has_remaining_rows(cleanup_job.id) then
          raise exception 'LEGACY_GEDCOM_CLEANUP_SNAPSHOT_ROWS_REMAIN'
            using errcode = '55000';
        end if;

        delete from private.project_dashboard_stats_cache cache
        where cache.project_id = cleanup_job.project_id;
        update private.legacy_gedcom_cleanup_jobs
        set status = 'completed', error = null,
            updated_at = clock_timestamp(), completed_at = clock_timestamp()
        where id = cleanup_job.id;
        return private.legacy_gedcom_cleanup_payload(cleanup_job.id);
      end if;

      current_phase := phases[cleanup_job.phase_index + 1];
      if current_phase = 'storage_objects' then
        if exists (
          select 1
          from private.legacy_gedcom_cleanup_storage_objects object
          where object.job_id = cleanup_job.id and object.deleted_at is null
        ) then
          return private.legacy_gedcom_cleanup_payload(cleanup_job.id);
        end if;
        cleanup_job.phase_index := cleanup_job.phase_index + 1;
        update private.legacy_gedcom_cleanup_jobs
        set phase_index = cleanup_job.phase_index, updated_at = clock_timestamp()
        where id = cleanup_job.id;
        continue;
      end if;

      affected_count := private.delete_legacy_gedcom_cleanup_phase(
        cleanup_job.id, current_phase, safe_batch_size
      );
      cleanup_job.processed_rows := cleanup_job.processed_rows + affected_count;
      if current_phase = 'persons' then
        cleanup_job.deleted_person_count := cleanup_job.deleted_person_count + affected_count;
      end if;
      if affected_count < safe_batch_size then
        cleanup_job.phase_index := cleanup_job.phase_index + 1;
      end if;

      update private.legacy_gedcom_cleanup_jobs
      set phase_index = cleanup_job.phase_index,
          processed_rows = cleanup_job.processed_rows,
          deleted_person_count = cleanup_job.deleted_person_count,
          updated_at = clock_timestamp()
      where id = cleanup_job.id;

      if affected_count > 0 then
        return private.legacy_gedcom_cleanup_payload(cleanup_job.id);
      end if;
    end loop;
  exception
    when query_canceled or serialization_failure or deadlock_detected or lock_not_available then
      raise;
    when others then
      update private.legacy_gedcom_cleanup_jobs
      set status = 'failed', error = left(sqlerrm, 2000), updated_at = clock_timestamp()
      where id = cleanup_job.id;
      return private.legacy_gedcom_cleanup_payload(cleanup_job.id);
  end;
end;
$$;

create or replace function public.process_next_legacy_gedcom_cleanup(
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  next_job_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  delete from private.legacy_gedcom_cleanup_jobs completed
  where completed.ctid in (
    select candidate.ctid
    from private.legacy_gedcom_cleanup_jobs candidate
    where candidate.status = 'completed'
      and candidate.completed_at < clock_timestamp() - interval '7 days'
    order by candidate.completed_at
    limit 10
  );

  select job.id into next_job_id
  from private.legacy_gedcom_cleanup_jobs job
  where job.status in ('queued', 'running', 'failed')
  order by case job.status when 'queued' then 0 when 'running' then 1 else 2 end,
           job.updated_at, job.created_at
  for update skip locked
  limit 1;
  if next_job_id is null then return null; end if;
  return public.process_legacy_gedcom_cleanup(next_job_id, batch_size);
end;
$$;

create or replace function public.list_legacy_gedcom_cleanup_storage_objects(
  target_job_id uuid,
  batch_size integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'attachmentId', object.attachment_id,
      'storageBucket', object.storage_bucket,
      'storagePath', object.storage_path
    ) order by object.storage_bucket, object.storage_path)
    from (
      select queued.*
      from private.legacy_gedcom_cleanup_storage_objects queued
      where queued.job_id = target_job_id and queued.deleted_at is null
      order by queued.storage_bucket, queued.storage_path
      limit greatest(1, least(coalesce(batch_size, 100), 500))
    ) object
  ), '[]'::jsonb);
end;
$$;

create or replace function public.mark_legacy_gedcom_cleanup_storage_deleted(
  target_job_id uuid,
  attachment_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(cardinality(attachment_ids), 0) > 500 then
    raise exception 'STORAGE_ACK_BATCH_TOO_LARGE' using errcode = '22023';
  end if;
  update private.legacy_gedcom_cleanup_storage_objects object
  set deleted_at = clock_timestamp()
  where object.job_id = target_job_id
    and object.attachment_id = any(coalesce(attachment_ids, array[]::uuid[]));
  return private.legacy_gedcom_cleanup_payload(target_job_id);
end;
$$;

revoke execute on function public.start_legacy_gedcom_cleanup(uuid, text, integer),
  public.get_legacy_gedcom_cleanup_status(uuid),
  public.cancel_legacy_gedcom_cleanup(uuid),
  public.process_legacy_gedcom_cleanup(uuid, integer),
  public.process_next_legacy_gedcom_cleanup(integer),
  public.list_legacy_gedcom_cleanup_storage_objects(uuid, integer),
  public.mark_legacy_gedcom_cleanup_storage_deleted(uuid, uuid[])
  from public, anon;

grant execute on function public.start_legacy_gedcom_cleanup(uuid, text, integer),
  public.get_legacy_gedcom_cleanup_status(uuid),
  public.cancel_legacy_gedcom_cleanup(uuid)
  to authenticated;

revoke execute on function public.process_legacy_gedcom_cleanup(uuid, integer),
  public.process_next_legacy_gedcom_cleanup(integer),
  public.list_legacy_gedcom_cleanup_storage_objects(uuid, integer),
  public.mark_legacy_gedcom_cleanup_storage_deleted(uuid, uuid[])
  from authenticated;

grant execute on function public.get_legacy_gedcom_cleanup_status(uuid),
  public.process_legacy_gedcom_cleanup(uuid, integer),
  public.process_next_legacy_gedcom_cleanup(integer),
  public.list_legacy_gedcom_cleanup_storage_objects(uuid, integer),
  public.mark_legacy_gedcom_cleanup_storage_deleted(uuid, uuid[])
  to service_role;

commit;
