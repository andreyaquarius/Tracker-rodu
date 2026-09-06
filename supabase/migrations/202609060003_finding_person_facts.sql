begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Exact roles, never substring matching: a groom's father is not the groom.
create or replace function security_private.finding_event_type_v1(kind text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case lower(btrim(kind))
    when 'народження' then 'birth' when 'birth' then 'birth'
    when 'хрещення' then 'baptism' when 'baptism' then 'baptism'
    when 'шлюб' then 'marriage' when 'marriage' then 'marriage'
    when 'розлучення' then 'divorce' when 'divorce' then 'divorce'
    when 'смерть' then 'death' when 'death' then 'death'
    when 'поховання' then 'burial' when 'burial' then 'burial'
    when 'перепис' then 'census' when 'перепис населення' then 'census'
    when 'ревізія' then 'revision_list' when 'сповідний розпис' then 'confession_list'
    when 'сповідні розписи' then 'confession_list'
    when 'посімейний список' then 'household_register' when 'погосподарська книга' then 'household_register'
    when 'проживання' then 'residence' when 'військова служба' then 'military'
    when 'освіта' then 'education' when 'професія' then 'occupation' when 'національність' then 'nationality'
    when 'спадкова справа' then 'probate' when 'військовий документ' then 'military'
    when 'імміграція' then 'immigration' when 'еміграція' then 'emigration'
    when 'згадка' then 'mention' else 'other' end;
$$;

create or replace function security_private.finding_subject_role_v1(kind text, participant_role text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  select case
    when kind in ('birth','baptism','christening') then lower(btrim(participant_role)) in
      ('дитина','новонароджена дитина','новонароджений','новонароджена','охрещена особа','child','subject')
    when kind = 'marriage' then lower(btrim(participant_role)) in ('наречений','наречена','молодий','молода','groom','bride')
    when kind = 'divorce' then lower(btrim(participant_role)) in
      ('чоловік','дружина','колишній чоловік','колишня дружина','наречений','наречена','подружжя','spouse')
    when kind in ('death','burial','cremation') then lower(btrim(participant_role)) in
      ('померла особа','померлий','померла','похована особа','deceased')
    else lower(btrim(participant_role)) not in
      ('свідок','священник','духовна особа','рабин','пастор','посадова особа','автор або укладач','укладач','суддя','представник','особа, яка повідомила','сусід','хрещений батько','хрещена мати','повитуха','поручитель')
  end;
$$;

-- A source owns only values it actually wrote. Manual edits and competing
-- sources survive subsequent syncs. Empty source fields never erase facts.
create or replace function security_private.merge_finding_fields_v1(current_value jsonb, proposed jsonb, previous jsonb)
returns jsonb language plpgsql immutable set search_path = pg_catalog as $$
declare result jsonb := coalesce(current_value,'{}'); owned jsonb := coalesce(previous,'{}'); conflicts jsonb := '[]'; field record;
begin
  for field in select * from jsonb_each(proposed) loop
    if field.value in ('null'::jsonb, '""'::jsonb, '[]'::jsonb) then continue; end if;
    if not result ? field.key or result -> field.key in ('null'::jsonb,'""'::jsonb,'[]'::jsonb)
       or (owned ? field.key and result -> field.key = owned -> field.key) then
      result := result || jsonb_build_object(field.key,field.value);
      owned := owned || jsonb_build_object(field.key,field.value);
    elsif result -> field.key is distinct from field.value then
      conflicts := conflicts || jsonb_build_array(field.key);
    end if;
  end loop;
  return jsonb_build_object('value',result,'owned',owned,'conflicts',conflicts);
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
  pair_ids uuid[]; tree_id_value uuid; relationship public.partner_relationships%rowtype;
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
          insert into public.family_groups(project_id,tree_id,group_type,primary_partner_1_id,primary_partner_2_id)
            values(p_project_id,tree_id_value,'couple',pair_ids[1],pair_ids[2]) returning id into group_id;
          insert into public.partner_relationships(project_id,tree_id,family_group_id,person_a_id,person_b_id,relationship_type,status,source_document_id,source_finding_id)
            values(p_project_id,tree_id_value,group_id,pair_ids[1],pair_ids[2],'marriage',case when kind='divorce' then 'ended' else 'unknown' end,finding.document_id,p_finding_id)
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
    else
      conflicts := conflicts || '[{"kind":"unresolvedPartners"}]'::jsonb;
    end if;
  end if;
  return jsonb_build_object('personIds',affected,'conflicts',conflicts);
end;
$$;

-- Keep canonical provenance when the ordinary person-save bridge reprojects
-- the client event. Validates source scope; does not widen any table policy.
create or replace function security_private.finding_event_provenance_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare source_id text;
begin
  -- The older bridge emits a second synthetic event from birth_date etc.
  -- A matching, explicitly sourced JSON event is projected by the newer
  -- bridge later in the same person update; don't count the same fact twice.
  if new.metadata->>'source'='persons_projection' and exists (
    select 1 from public.persons p,
      jsonb_array_elements(p.custom_fields->'__trackerRoduPersonEvents') item(value)
    join public.findings f on f.id::text=item.value->>'sourceFindingId' and f.project_id=new.project_id
    where p.id=new.person_id and p.project_id=new.project_id
      and item.value->>'type'=new.event_type
      and coalesce(item.value->>'date','')=coalesce(new.event_date,'')
      and coalesce(item.value->>'placeName','')=coalesce(new.place_name,'')
  ) then return null; end if;
  if new.metadata->>'source'='persons_custom_event_projection' then
    select item.value->>'sourceFindingId' into source_id
      from public.persons p, jsonb_array_elements(p.custom_fields->'__trackerRoduPersonEvents') item(value)
      where p.id=new.person_id and p.project_id=new.project_id and item.value->>'id'=new.metadata->>'clientEventId' limit 1;
    if source_id is not null then
      select f.id,f.document_id into new.source_finding_id,new.source_document_id from public.findings f
        where f.project_id=new.project_id and f.id::text=source_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger zz_finding_event_provenance before insert or update on public.person_timeline_events
  for each row execute function security_private.finding_event_provenance_v1();

revoke all on function security_private.finding_event_type_v1(text), security_private.finding_subject_role_v1(text,text),
  security_private.merge_finding_fields_v1(jsonb,jsonb,jsonb), security_private.finding_event_provenance_v1() from public,anon,authenticated;
create or replace function public.sync_finding_person_facts_v1(p_project_id uuid, p_finding_id uuid)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select security_private.sync_finding_person_facts_v1(p_project_id,p_finding_id);
$$;
revoke all on function security_private.sync_finding_person_facts_v1(uuid,uuid),public.sync_finding_person_facts_v1(uuid,uuid) from public,anon;
grant usage on schema security_private to authenticated;
grant execute on function security_private.sync_finding_person_facts_v1(uuid,uuid) to authenticated;
grant execute on function public.sync_finding_person_facts_v1(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
