begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Locate former participants without scanning every person in a large project.
create index if not exists persons_finding_fact_sources_idx
  on public.persons using gin ((custom_fields->'__trackerRoduFindingFacts'))
  where custom_fields ? '__trackerRoduFindingFacts';
create index if not exists partner_relationships_finding_fact_sources_idx
  on public.partner_relationships using gin ((metadata->'findingFacts'))
  where metadata ? 'findingFacts';
create index if not exists partner_relationships_source_finding_idx
  on public.partner_relationships (project_id,source_finding_id)
  where source_finding_id is not null;

-- Undo only values written by this source, not manual edits or another
-- still-linked source's equal value. Callers whitelist the updated columns.
create or replace function security_private.remove_finding_owned_fields_v1(current_value jsonb, owned jsonb, remaining_claims jsonb)
returns jsonb language plpgsql immutable set search_path=pg_catalog as $$
declare result jsonb := current_value; field record;
begin
  for field in select * from jsonb_each(coalesce(owned,'{}')) loop
    if result->field.key = field.value and not exists (
      select 1 from jsonb_array_elements(coalesce(remaining_claims,'[]')) claim
        where claim->field.key = field.value
    ) then result := result || jsonb_build_object(field.key,''); end if;
  end loop;
  return result;
end;
$$;

-- Private helper: only called after the public sync's edit check and locks.
-- No participant trigger: the client replaces participants in several passes,
-- so intermediate DELETEs must NOT retract still-linked facts.
create or replace function security_private.detach_obsolete_finding_facts_v1(
  p_project_id uuid, p_finding_id uuid, keep_person_ids uuid[], keep_pair_ids uuid[]
)
returns uuid[] language plpgsql set search_path=pg_catalog,public,security_private,pg_temp as $$
declare
  person public.persons%rowtype; relationship public.partner_relationships%rowtype;
  source public.findings%rowtype; events jsonb; custom jsonb; facts jsonb; claims jsonb; owned jsonb;
  remaining_sources jsonb; remaining_source_id uuid; remaining_document_id uuid;
  field record; receiver text;
  removed uuid[] := '{}'; auto_created boolean;
begin
  select * into source from public.findings where id=p_finding_id and project_id=p_project_id;
  for person in select p.* from public.persons p where p.project_id=p_project_id
    and p.custom_fields ? '__trackerRoduFindingFacts'
    and (p.custom_fields->'__trackerRoduFindingFacts') ? p_finding_id::text
    and not (p.id=any(keep_person_ids)) order by p.id for update
  loop
    select coalesce(jsonb_agg(value),'[]') into events
      from jsonb_array_elements(coalesce(person.custom_fields->'__trackerRoduPersonEvents','[]'))
      where coalesce(value->>'sourceFindingId','')<>p_finding_id::text
        and coalesce(value->>'id','')<>'finding:'||p_finding_id::text;
    select coalesce(jsonb_agg(jsonb_build_object('__sourceFindingId',value->>'sourceFindingId') || case value->>'type'
      when 'birth' then jsonb_build_object('birth_date',value->'date','birth_place',value->'placeName')
      when 'marriage' then jsonb_build_object('marriage_date',value->'date','marriage_place',value->'placeName')
      when 'death' then jsonb_build_object('death_date',value->'date','death_place',value->'placeName')
      when 'residence' then jsonb_build_object('residence_places',value->'placeName')
      else '{}'::jsonb end),'[]') into claims
      from jsonb_array_elements(events) where exists(
        select 1 from public.finding_participants fp where fp.project_id=p_project_id
          and fp.person_id=person.id and fp.finding_id::text=value->>'sourceFindingId'
      );
    owned := person.custom_fields #> array['__trackerRoduFindingFacts',p_finding_id::text];
    facts := security_private.remove_finding_owned_fields_v1(to_jsonb(person),owned,claims);
    remaining_sources := (person.custom_fields->'__trackerRoduFindingFacts')-p_finding_id::text;
    -- Transfer ownership of corroborated auto-filled values. Otherwise the
    -- final unlink would leave a value whose original owner was removed first.
    for field in select * from jsonb_each(coalesce(owned,'{}')) loop
      if to_jsonb(person)->field.key is distinct from field.value then continue; end if;
      select claim->>'__sourceFindingId' into receiver from jsonb_array_elements(claims) claim
        where claim->field.key=field.value order by claim->>'__sourceFindingId' limit 1;
      if receiver is not null then
        remaining_sources := remaining_sources || jsonb_build_object(receiver,
          coalesce(remaining_sources->receiver,'{}') || jsonb_build_object(field.key,field.value));
      end if;
    end loop;
    custom := person.custom_fields || jsonb_build_object('__trackerRoduPersonEvents',events,
      '__trackerRoduFindingFacts',remaining_sources);
    update public.persons set custom_fields=custom,updated_at=now(),
      birth_date=facts->>'birth_date',birth_place=facts->>'birth_place',
      marriage_date=facts->>'marriage_date',marriage_place=facts->>'marriage_place',
      death_date=facts->>'death_date',death_place=facts->>'death_place',residence_places=facts->>'residence_places'
      where id=person.id and project_id=p_project_id;
    removed := array_append(removed,person.id);
  end loop;

  for relationship in select pr.* from public.partner_relationships pr where pr.project_id=p_project_id
    and (pr.source_finding_id=p_finding_id or
      (pr.metadata ? 'findingFacts' and (pr.metadata->'findingFacts') ? p_finding_id::text))
    and not (coalesce(cardinality(keep_pair_ids),0)=2
      and pr.person_a_id=any(keep_pair_ids) and pr.person_b_id=any(keep_pair_ids))
    order by pr.tree_id,pr.id for update
  loop
    owned := coalesce(relationship.metadata #> array['findingFacts',p_finding_id::text],'{}');
    remaining_sources := coalesce(relationship.metadata->'findingFacts','{}')-p_finding_id::text;
    -- A second source may corroborate an equal date without owning the column.
    select coalesce(jsonb_agg(value || jsonb_build_object('__sourceFindingId',key)),'[]') into claims from jsonb_each(remaining_sources);
    select claims || coalesce(jsonb_agg(jsonb_build_object('__sourceFindingId',f.id) || case security_private.finding_event_type_v1(f.finding_type)
      when 'marriage' then jsonb_build_object('start_date',f.event_date,'start_place',f.place)
      when 'divorce' then jsonb_build_object('end_date',f.event_date,'end_place',f.place)
      else '{}'::jsonb end),'[]') into claims
      from public.findings f where f.project_id=p_project_id and remaining_sources ? f.id::text;
    facts := security_private.remove_finding_owned_fields_v1(to_jsonb(relationship),owned,claims);
    for field in select * from jsonb_each(owned) loop
      if to_jsonb(relationship)->field.key is distinct from field.value then continue; end if;
      select claim->>'__sourceFindingId' into receiver from jsonb_array_elements(claims) claim
        where claim->field.key=field.value order by claim->>'__sourceFindingId' limit 1;
      if receiver is not null then
        remaining_sources := remaining_sources || jsonb_build_object(receiver,
          coalesce(remaining_sources->receiver,'{}') || jsonb_build_object(field.key,field.value));
      end if;
    end loop;
    auto_created := relationship.metadata->>'source'='finding_person_facts'
      or (relationship.source_finding_id=p_finding_id
        and coalesce(relationship.metadata->>'source','')=''
        and (relationship.metadata->'findingFacts') ? p_finding_id::text);
    if auto_created and remaining_sources='{}'
      and (relationship.metadata-'source'-'createdByFinding'-'findingFacts')='{}'
      and coalesce(facts->>'start_date','')='' and coalesce(facts->>'start_place','')=''
      and coalesce(facts->>'end_date','')='' and coalesce(facts->>'end_place','')=''
      and relationship.notes='' and relationship.evidence_status='unknown' and relationship.confidence=0
      and not exists(select 1 from public.legacy_person_relation_graph_edges m
        where m.project_id=p_project_id and m.edge_kind='partner' and m.edge_id=relationship.id)
    then
      delete from public.partner_relationships where project_id=p_project_id and id=relationship.id;
      -- Deliberately keep the couple/group and memberships: they can be used
      -- by parent sets, children or research evidence. A new marriage reuses it.
    else
      select f.id,f.document_id into remaining_source_id,remaining_document_id from public.findings f
        where f.project_id=p_project_id and remaining_sources ? f.id::text order by f.id limit 1;
      custom := relationship.metadata || jsonb_build_object('findingFacts',remaining_sources);
      if custom->>'createdByFinding'=p_finding_id::text then
        custom := custom-'createdByFinding';
        if remaining_source_id is not null then
          custom := custom || jsonb_build_object('createdByFinding',remaining_source_id);
        elsif custom->>'source'='finding_person_facts' then
          custom := custom || jsonb_build_object('source','retained_finding_fact');
        end if;
      end if;
      update public.partner_relationships set metadata=custom,updated_at=now(),
        start_date=facts->>'start_date',start_place=facts->>'start_place',
        end_date=facts->>'end_date',end_place=facts->>'end_place',
        source_finding_id=case when source_finding_id=p_finding_id then remaining_source_id else source_finding_id end,
        source_document_id=case when source_finding_id=p_finding_id and source_document_id is not distinct from source.document_id
          then remaining_document_id else source_document_id end
        where id=relationship.id and project_id=p_project_id;
    end if;
  end loop;
  return removed;
end;
$$;

create or replace function security_private.sync_finding_person_facts_v1(p_project_id uuid, p_finding_id uuid)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, security_private, pg_temp
set lock_timeout = '2s'
set statement_timeout = '8s'
as $$
declare
  finding public.findings%rowtype; person public.persons%rowtype; participant record;
  kind text; event_kind text; event_id text := 'finding:' || p_finding_id::text;
  event_json jsonb; previous_event jsonb; events jsonb; proposed jsonb; merged jsonb; facts jsonb; core_owned jsonb;
  custom jsonb; details text; subject_names text; related_ids jsonb; reference_scans jsonb; conflicts jsonb := '[]'; affected jsonb := '[]'; meta jsonb;
  linked_ids uuid[]; removed_ids uuid[]; pair_ids uuid[]; tree_id_value uuid; relationship public.partner_relationships%rowtype;
  relationship_count integer; group_id uuid; pair_type text; relation_patch jsonb;
begin
  if auth.uid() is null or not public.can_edit_project(p_project_id) then
    raise exception 'PROJECT_EDIT_REQUIRED' using errcode = '42501';
  end if;
  -- Serialize the snapshot; facts are derived from the SAVED source, never a
  -- browser-supplied person patch or an arbitrary cross-project person id.
  select * into finding from public.findings where project_id=p_project_id and id=p_finding_id for update;
  if not found then raise exception 'FINDING_NOT_FOUND' using errcode='P0002'; end if;
  perform 1 from public.finding_participants where project_id=p_project_id and finding_id=p_finding_id order by id for update;
  if (select count(*) from public.finding_participants where project_id=p_project_id and finding_id=p_finding_id) > 200 then
    raise exception 'FINDING_FACTS_PARTICIPANT_LIMIT' using errcode='54000';
  end if;
  kind := security_private.finding_event_type_v1(finding.finding_type);
  select coalesce(array_agg(distinct fp.person_id order by fp.person_id),'{}') into linked_ids
    from public.finding_participants fp join public.persons p on p.id=fp.person_id and p.project_id=fp.project_id
    where fp.project_id=p_project_id and fp.finding_id=p_finding_id;
  select coalesce(array_agg(distinct fp.person_id order by fp.person_id),'{}') into pair_ids
    from public.finding_participants fp join public.persons p on p.id=fp.person_id and p.project_id=fp.project_id
    where fp.project_id=p_project_id and fp.finding_id=p_finding_id
      and kind in ('marriage','divorce') and security_private.finding_subject_role_v1(kind,fp.role);
  -- Lock old and current profiles together in UUID order, before graph rows.
  perform 1 from public.persons p where p.project_id=p_project_id and p.id in (
    select unnest(linked_ids)
    union
    select prior.id from public.persons prior where prior.project_id=p_project_id
      and prior.custom_fields ? '__trackerRoduFindingFacts'
      and (prior.custom_fields->'__trackerRoduFindingFacts') ? p_finding_id::text
  ) order by p.id for update;
  removed_ids := security_private.detach_obsolete_finding_facts_v1(p_project_id,p_finding_id,linked_ids,pair_ids);
  affected := to_jsonb(removed_ids);
  meta := coalesce(finding.custom_fields -> '__trackerRoduFindingMeta','{}');
  select coalesce(jsonb_agg(value || jsonb_build_object('deleteOnRemove',false,
    'referenceOwnerType','findings','referenceOwnerId',p_finding_id)),'[]') into reference_scans
    from jsonb_array_elements(coalesce(meta->'scans','[]'));
  details := concat_ws(E'\n',
    'Джерело: знахідка «' || finding.finding_type || '».',
    nullif(concat_ws(' · ',nullif(finding.archive,''),nullif(finding.fund,''),nullif(finding.description,''),nullif(finding.file_reference,''),nullif(finding.page,'')),''),
    nullif(finding.source_url,''), nullif(finding.summary,''), nullif(finding.transcription,''),
    nullif(finding.conclusion,''), nullif(finding.notes,''));

  -- Lock profiles in UUID order, shared by concurrent finding syncs.
  for person in select p.* from public.persons p
    where p.project_id=p_project_id and exists(select 1 from public.finding_participants fp
      where fp.project_id=p_project_id and fp.finding_id=p_finding_id and fp.person_id=p.id)
    order by p.id for update
  loop
    select fp.*, security_private.finding_subject_role_v1(kind,fp.role) as is_subject into participant
    from public.finding_participants fp
    where fp.project_id=p_project_id and fp.finding_id=p_finding_id and fp.person_id=person.id
    order by security_private.finding_subject_role_v1(kind,fp.role) desc, fp.id limit 1;
    event_kind := case when participant.is_subject then kind else 'mention' end;
    custom := coalesce(person.custom_fields,'{}');
    events := coalesce(custom -> '__trackerRoduPersonEvents','[]');
    select value into previous_event from jsonb_array_elements(events)
      where value ->> 'sourceFindingId'=p_finding_id::text or value ->> 'id'=event_id limit 1;
    select string_agg(fp.name, ', ' order by fp.id), coalesce(jsonb_agg(distinct fp.person_id) filter(where fp.person_id is not null),'[]')
      into subject_names, related_ids from public.finding_participants fp
      where fp.project_id=p_project_id and fp.finding_id=p_finding_id and fp.id<>participant.id
        and (case when participant.context_target_participant_id is not null then fp.id=participant.context_target_participant_id
          else security_private.finding_subject_role_v1(kind,fp.role) end);
    proposed := jsonb_build_object('type',event_kind,'title',
      case when participant.is_subject then finding.finding_type else
        coalesce(nullif(participant.role,''),'Учасник') || ' · ' || finding.finding_type || coalesce(' · ' || subject_names,'') end,
      'date',finding.event_date,'placeName',finding.place,'value',finding.summary,
      'notes',concat_ws(E'\n', details, nullif(participant.role || ': ' || participant.name,''),
        case when subject_names is not null then 'Подія стосується: ' || subject_names end,nullif(participant.notes,'')),
      'scans',reference_scans,'geo',meta -> 'geo');
    merged := security_private.merge_finding_fields_v1(coalesce(previous_event,'{}'), proposed, previous_event -> 'sourceSnapshot');
    if jsonb_array_length(merged -> 'conflicts')>0 then conflicts := conflicts || jsonb_build_array(jsonb_build_object('personId',person.id,'fields',merged->'conflicts','kind','event')); end if;
    event_json := (merged -> 'value') || jsonb_build_object('id',event_id,'personId',person.id,
      'sourceFindingId',p_finding_id,'sourceDocumentId',finding.document_id,'relatedPersonIds',related_ids,'sourceSnapshot',merged -> 'owned');
    select coalesce(jsonb_agg(value),'[]') into events from jsonb_array_elements(events)
      where coalesce(value ->> 'sourceFindingId','')<>p_finding_id::text and coalesce(value ->> 'id','')<>event_id;
    events := events || jsonb_build_array(event_json);
    proposed := case event_kind
      when 'birth' then jsonb_build_object('birth_date',finding.event_date,'birth_place',finding.place)
      when 'marriage' then jsonb_build_object('marriage_date',finding.event_date,'marriage_place',finding.place)
      when 'death' then jsonb_build_object('death_date',finding.event_date,'death_place',finding.place)
      when 'residence' then jsonb_build_object('residence_places',finding.place)
      else '{}'::jsonb end;
    core_owned := custom #> array['__trackerRoduFindingFacts',p_finding_id::text];
    merged := security_private.merge_finding_fields_v1(to_jsonb(person),proposed,core_owned);
    facts := merged -> 'value';
    if jsonb_array_length(merged -> 'conflicts')>0 then conflicts := conflicts || jsonb_build_array(jsonb_build_object('personId',person.id,'fields',merged->'conflicts','kind','profile')); end if;
    custom := custom || jsonb_build_object('__trackerRoduPersonEvents',events,
      '__trackerRoduFindingFacts',coalesce(custom -> '__trackerRoduFindingFacts','{}') || jsonb_build_object(p_finding_id::text,merged -> 'owned'));
    -- Existing person triggers project these events into person_timeline_events.
    update public.persons set custom_fields=custom,
      birth_date=facts->>'birth_date', birth_place=facts->>'birth_place',
      marriage_date=facts->>'marriage_date', marriage_place=facts->>'marriage_place',
      death_date=facts->>'death_date', death_place=facts->>'death_place', residence_places=facts->>'residence_places'
    where id=person.id and project_id=p_project_id and
      (custom_fields is distinct from custom or
       row(birth_date,birth_place,marriage_date,marriage_place,death_date,death_place,residence_places) is distinct from
       row(facts->>'birth_date',facts->>'birth_place',facts->>'marriage_date',facts->>'marriage_place',facts->>'death_date',facts->>'death_place',facts->>'residence_places'));
    affected := affected || jsonb_build_array(person.id);
  end loop;

  if kind in ('marriage','divorce') then
    select array_agg(distinct fp.person_id order by fp.person_id) into pair_ids
    from public.finding_participants fp join public.persons p on p.id=fp.person_id and p.project_id=fp.project_id
    where fp.project_id=p_project_id and fp.finding_id=p_finding_id
      and security_private.finding_subject_role_v1(kind,fp.role);
    if coalesce(cardinality(pair_ids),0)=2 then
      if not exists(select 1 from public.family_trees where project_id=p_project_id) then
        insert into public.family_trees(project_id,title,is_default,root_person_id)
          values(p_project_id,'Родове дерево',true,pair_ids[1]) on conflict(project_id) where is_default do nothing;
      end if;
      -- Update the existing shared relationship in every tree containing it.
      -- If absent, create it in the default tree only, with an explicit couple.
      for tree_id_value in
        select distinct pr.tree_id from public.partner_relationships pr
        where pr.project_id=p_project_id and pr.person_a_id=any(pair_ids) and pr.person_b_id=any(pair_ids)
          and pr.relationship_type in ('marriage','divorced')
        union
        select ft.id from public.family_trees ft where ft.project_id=p_project_id and ft.is_default
          and not exists(select 1 from public.partner_relationships pr where pr.project_id=p_project_id
            and pr.person_a_id=any(pair_ids) and pr.person_b_id=any(pair_ids) and pr.relationship_type in ('marriage','divorced'))
      loop
        perform 1 from public.family_trees where id=tree_id_value and project_id=p_project_id for update;
        select count(*) into relationship_count from public.partner_relationships pr
          where pr.project_id=p_project_id and pr.tree_id=tree_id_value
            and pr.person_a_id=any(pair_ids) and pr.person_b_id=any(pair_ids) and pr.relationship_type in ('marriage','divorced');
        if relationship_count>1 then
          conflicts := conflicts || jsonb_build_array(jsonb_build_object('kind','ambiguousMarriage','treeId',tree_id_value)); continue;
        end if;
        if relationship_count=0 then
          -- A group can legitimately outlive its marriage (e.g. it has children).
          -- Match the expression/partial unique index in either partner order.
          insert into public.family_groups(project_id,tree_id,group_type,primary_partner_1_id,primary_partner_2_id)
            values(p_project_id,tree_id_value,'couple',pair_ids[1],pair_ids[2])
            on conflict (tree_id, least(primary_partner_1_id,primary_partner_2_id), greatest(primary_partner_1_id,primary_partner_2_id))
              where group_type='couple' and primary_partner_1_id is not null and primary_partner_2_id is not null
            do nothing;
          select fg.id into strict group_id from public.family_groups fg
            where fg.project_id=p_project_id and fg.tree_id=tree_id_value and fg.group_type='couple'
              and least(fg.primary_partner_1_id,fg.primary_partner_2_id)=pair_ids[1]
              and greatest(fg.primary_partner_1_id,fg.primary_partner_2_id)=pair_ids[2]
            for update;
          insert into public.partner_relationships(project_id,tree_id,family_group_id,person_a_id,person_b_id,relationship_type,status,source_document_id,source_finding_id,metadata)
            values(p_project_id,tree_id_value,group_id,pair_ids[1],pair_ids[2],'marriage',case when kind='divorce' then 'ended' else 'unknown' end,finding.document_id,p_finding_id,
              jsonb_build_object('source','finding_person_facts','createdByFinding',p_finding_id))
            returning * into relationship;
          insert into public.family_group_members(project_id,family_group_id,person_id,member_role)
            select p_project_id,group_id,unnest(pair_ids),'partner' on conflict do nothing;
          insert into public.family_tree_persons(project_id,tree_id,person_id)
            select p_project_id,tree_id_value,unnest(pair_ids) on conflict do nothing;
        else
          select * into relationship from public.partner_relationships pr where pr.project_id=p_project_id and pr.tree_id=tree_id_value
            and pr.person_a_id=any(pair_ids) and pr.person_b_id=any(pair_ids) and pr.relationship_type in ('marriage','divorced') for update;
        end if;
        relation_patch := case when kind='marriage'
          then jsonb_build_object('start_date',finding.event_date,'start_place',finding.place)
          else jsonb_build_object('end_date',finding.event_date,'end_place',finding.place) end;
        merged := security_private.merge_finding_fields_v1(to_jsonb(relationship),relation_patch,
          relationship.metadata #> array['findingFacts',p_finding_id::text]);
        if jsonb_array_length(merged->'conflicts')>0 then conflicts := conflicts || jsonb_build_array(jsonb_build_object('kind','marriage','relationshipId',relationship.id,'fields',merged->'conflicts')); end if;
        facts := merged->'value';
        custom := relationship.metadata || jsonb_build_object('findingFacts',coalesce(relationship.metadata->'findingFacts','{}') || jsonb_build_object(p_finding_id::text,merged->'owned'));
        update public.partner_relationships set
          start_date=facts->>'start_date',start_place=facts->>'start_place',end_date=facts->>'end_date',end_place=facts->>'end_place',
          status=case when kind='divorce' then 'ended' else status end,
          source_finding_id=coalesce(source_finding_id,p_finding_id),source_document_id=coalesce(source_document_id,finding.document_id),metadata=custom
        where id=relationship.id and project_id=p_project_id and
          (metadata is distinct from custom or row(start_date,start_place,end_date,end_place) is distinct from row(facts->>'start_date',facts->>'start_place',facts->>'end_date',facts->>'end_place') or (kind='divorce' and status<>'ended'));
      end loop;
      if tree_id_value is null then conflicts := conflicts || '[{"kind":"noDefaultTree"}]'::jsonb; end if;
    elsif coalesce(cardinality(pair_ids),0)>2 then
      conflicts := conflicts || '[{"kind":"unresolvedPartners"}]'::jsonb;
    end if;
  end if;
  return jsonb_build_object('personIds',affected,'conflicts',conflicts);
end;
$$;

revoke all on function security_private.remove_finding_owned_fields_v1(jsonb,jsonb,jsonb),
  security_private.detach_obsolete_finding_facts_v1(uuid,uuid,uuid[],uuid[]) from public,anon,authenticated;
revoke all on function security_private.sync_finding_person_facts_v1(uuid,uuid) from public,anon;
grant execute on function security_private.sync_finding_person_facts_v1(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
