begin;

set local lock_timeout = '5s';
set local statement_timeout = '3min';

-- TЗ №13 §20.  A marriage sponsor must identify the concrete spouse for
-- whom the role was performed.  The old generic `sponsor` type remains
-- readable for legacy and non-marriage assertions.
insert into public.context_relation_types as existing_type (
  code,
  category,
  directionality,
  label_uk,
  inverse_code,
  inverse_label_uk,
  source_role_uk,
  target_role_uk,
  icon_token,
  color_role,
  is_system,
  metadata
)
values
  (
    'sponsor_for_bride',
    'church',
    'directed',
    'Поручитель по нареченій',
    'bride_sponsored_by',
    'Наречена, для якої поручалися',
    'Поручитель по нареченій',
    'Наречена',
    'sponsor',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'sponsor_for_bride',
      'targetEndpoint', 'bride',
      'weddingSide', 'bride',
      'genericFallbackCode', 'sponsor'
    )
  ),
  (
    'sponsor_for_groom',
    'church',
    'directed',
    'Поручитель по нареченому',
    'groom_sponsored_by',
    'Наречений, для якого поручалися',
    'Поручитель по нареченому',
    'Наречений',
    'sponsor',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'sponsor_for_groom',
      'targetEndpoint', 'groom',
      'weddingSide', 'groom',
      'genericFallbackCode', 'sponsor'
    )
  )
on conflict (lower(code)) where project_id is null do update
set
  category = excluded.category,
  directionality = excluded.directionality,
  label_uk = excluded.label_uk,
  inverse_code = excluded.inverse_code,
  inverse_label_uk = excluded.inverse_label_uk,
  source_role_uk = excluded.source_role_uk,
  target_role_uk = excluded.target_role_uk,
  icon_token = excluded.icon_token,
  color_role = excluded.color_role,
  is_system = true,
  is_active = true,
  metadata = existing_type.metadata || excluded.metadata
where row(
  existing_type.category,
  existing_type.directionality,
  existing_type.label_uk,
  existing_type.inverse_code,
  existing_type.inverse_label_uk,
  existing_type.source_role_uk,
  existing_type.target_role_uk,
  existing_type.icon_token,
  existing_type.color_role,
  existing_type.is_system,
  existing_type.is_active,
  existing_type.metadata
) is distinct from row(
  excluded.category,
  excluded.directionality,
  excluded.label_uk,
  excluded.inverse_code,
  excluded.inverse_label_uk,
  excluded.source_role_uk,
  excluded.target_role_uk,
  excluded.icon_token,
  excluded.color_role,
  true,
  true,
  existing_type.metadata || excluded.metadata
);

update public.context_relation_types relation_type
set metadata = relation_type.metadata || jsonb_build_object(
  'isGenericPersonRole', true,
  'legacyAmbiguous', true,
  'allowNewManualAssertions', false,
  'specificReplacementCodes', jsonb_build_array(
    'sponsor_for_bride', 'sponsor_for_groom'
  )
)
where relation_type.project_id is null
  and relation_type.code = 'sponsor'
  and relation_type.metadata is distinct from relation_type.metadata || jsonb_build_object(
    'isGenericPersonRole', true,
    'legacyAmbiguous', true,
    'allowNewManualAssertions', false,
    'specificReplacementCodes', jsonb_build_array(
      'sponsor_for_bride', 'sponsor_for_groom'
    )
  );

-- Preserve every mapping introduced by migration 016 and add only the two
-- exact sponsor-side forms.  Generic sponsor wording remains generic; target
-- selection still has to be explicit whenever both spouses are present.
create or replace function security_private.finding_context_type_code_v1(
  p_finding_type text,
  p_participant_role text
)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, security_private
as $function$
declare
  normalized_role text := security_private.normalize_finding_participant_role_v1(p_participant_role);
  finding_kind text := security_private.finding_kind_for_context_v1(p_finding_type);
begin
  if normalized_role in (
    'хрещений батько', 'хресний батько', 'godfather'
  ) then return 'godfather'; end if;
  if normalized_role in (
    'хрещена мати', 'хресна мати', 'godmother'
  ) then return 'godmother'; end if;
  if normalized_role in (
    'свідок по нареченій', 'свідок нареченої',
    'свідок зі сторони нареченої', 'свідок з боку нареченої',
    'witness for bride', 'bride witness'
  ) then return 'witness_for_bride'; end if;
  if normalized_role in (
    'свідок по нареченому', 'свідок нареченого',
    'свідок зі сторони нареченого', 'свідок з боку нареченого',
    'witness for groom', 'groom witness'
  ) then return 'witness_for_groom'; end if;
  if normalized_role in (
    'поручитель по нареченій', 'поручитель нареченої',
    'поручитель зі сторони нареченої', 'поручитель з боку нареченої',
    'sponsor for bride', 'bride sponsor', 'bondsman for bride'
  ) then return 'sponsor_for_bride'; end if;
  if normalized_role in (
    'поручитель по нареченому', 'поручитель нареченого',
    'поручитель зі сторони нареченого', 'поручитель з боку нареченого',
    'sponsor for groom', 'groom sponsor', 'bondsman for groom'
  ) then return 'sponsor_for_groom'; end if;
  if normalized_role in ('свідок', 'свідки', 'witness') then
    if finding_kind = 'marriage' then return null; end if;
    return 'event_witness';
  end if;
  if normalized_role in (
    'повитуха', 'баба-повитуха', 'акушерка', 'midwife'
  ) then return 'midwife'; end if;
  if normalized_role in (
    'поручитель', 'поручник', 'шафер', 'bondsman', 'sponsor'
  ) then return 'sponsor'; end if;
  if normalized_role in (
    'священник', 'священик', 'духовна особа', 'ієрей', 'дяк',
    'псаломщик', 'рабин', 'равин', 'пастор', 'priest', 'clergy',
    'rabbi', 'pastor'
  ) then return 'clergy'; end if;
  if normalized_role in (
    'посадова особа', 'укладач', 'автор або укладач', 'реєстратор',
    'суддя', 'командир', 'представник', 'official', 'registrar', 'judge'
  ) then return 'official'; end if;
  if normalized_role in (
    'особа, яка повідомила', 'особа яка повідомила', 'інформатор', 'informant'
  ) then return 'informant'; end if;
  if normalized_role in (
    'голова господарства', 'голова двору', 'голова родини',
    'household head'
  ) then return 'household_head'; end if;
  if normalized_role in (
    'член господарства', 'мешканець господарства', 'household member'
  ) then return 'household_member'; end if;
  if normalized_role in (
    'наймит або служник', 'наймит', 'служник', 'слуга', 'servant'
  ) then return 'servant'; end if;
  if normalized_role in ('опікун', 'піклувальник', 'guardian') then
    return 'guardian_non_parent';
  end if;
  if normalized_role in ('сусід', 'сусідка', 'neighbor') then
    return 'neighbor';
  end if;
  return null;
end;
$function$;

create or replace function security_private.finding_context_target_priority_v1(
  p_finding_type text,
  p_context_type_code text,
  p_target_role text
)
returns integer
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, security_private
as $function$
declare
  normalized_role text := security_private.normalize_finding_participant_role_v1(p_target_role);
  finding_kind text := security_private.finding_kind_for_context_v1(p_finding_type);
begin
  if p_context_type_code is null then return null; end if;

  if p_context_type_code in ('godfather', 'godmother', 'midwife') then
    if normalized_role in (
      'дитина', 'новонароджений', 'новонароджена', 'охрещений',
      'охрещена', 'народжений', 'народжена', 'child', 'newborn', 'baptized'
    ) then return 0; end if;
    return null;
  end if;

  if p_context_type_code in ('witness_for_bride', 'sponsor_for_bride') then
    if finding_kind = 'marriage'
       and normalized_role in ('наречена', 'молода', 'bride') then return 0; end if;
    return null;
  end if;
  if p_context_type_code in ('witness_for_groom', 'sponsor_for_groom') then
    if finding_kind = 'marriage'
       and normalized_role in ('наречений', 'молодий', 'groom') then return 0; end if;
    return null;
  end if;

  if p_context_type_code in ('servant', 'household_member') then
    if normalized_role in (
      'голова господарства', 'голова двору', 'голова родини', 'household head'
    ) then return 0; end if;
    return null;
  end if;
  if p_context_type_code = 'guardian_non_parent' then
    if normalized_role in ('підопічний', 'підопічна', 'ward') then return 0; end if;
    if normalized_role in ('основна особа', 'згадана особа', 'subject') then return 10; end if;
    return null;
  end if;
  if p_context_type_code = 'household_head' then
    if normalized_role in (
      'член господарства', 'мешканець', 'наймит або служник', 'наймит',
      'служник', 'слуга', 'орендар', 'household member', 'resident',
      'servant', 'tenant'
    ) then return 0; end if;
    return null;
  end if;
  if finding_kind = 'birth' then
    if normalized_role in (
      'дитина', 'новонароджений', 'новонароджена', 'охрещений',
      'охрещена', 'народжений', 'народжена', 'child', 'newborn', 'baptized'
    ) then return 0; end if;
    return null;
  end if;
  if finding_kind = 'marriage' then
    if normalized_role in (
      'наречений', 'молодий', 'groom', 'наречена', 'молода', 'bride'
    ) then return 0; end if;
    return null;
  end if;
  if finding_kind = 'death' then
    if normalized_role in (
      'померла особа', 'померлий', 'померла', 'покійний', 'покійна',
      'похований', 'похована', 'deceased', 'buried person'
    ) then return 0; end if;
    return null;
  end if;
  if finding_kind = 'household' then
    if normalized_role in (
      'голова господарства', 'голова двору', 'голова родини', 'household head'
    ) then return 0; end if;
    return null;
  end if;
  if normalized_role in (
    'основна особа', 'згадана особа', 'військовослужбовець',
    'позивач', 'відповідач', 'потерпілий', 'обвинувачений',
    'власник', 'орендар', 'subject', 'primary person'
  ) then return 0; end if;
  return null;
end;
$function$;

create or replace function security_private.legacy_person_context_type_code_v1(
  p_relation_type text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select case lower(btrim(coalesce(p_relation_type, '')))
    when 'хрещений батько' then 'godfather'
    when 'хрещений' then 'godfather'
    when 'хрещена мати' then 'godmother'
    when 'хрещена' then 'godmother'
    when 'хрещеник' then 'godparent'
    when 'хрещениця' then 'godparent'
    when 'свідок по нареченій' then 'witness_for_bride'
    when 'свідок нареченої' then 'witness_for_bride'
    when 'свідок зі сторони нареченої' then 'witness_for_bride'
    when 'свідок по нареченому' then 'witness_for_groom'
    when 'свідок нареченого' then 'witness_for_groom'
    when 'свідок зі сторони нареченого' then 'witness_for_groom'
    when 'свідок' then 'witness'
    when 'поручитель по нареченій' then 'sponsor_for_bride'
    when 'поручитель нареченої' then 'sponsor_for_bride'
    when 'поручитель зі сторони нареченої' then 'sponsor_for_bride'
    when 'поручитель по нареченому' then 'sponsor_for_groom'
    when 'поручитель нареченого' then 'sponsor_for_groom'
    when 'поручитель зі сторони нареченого' then 'sponsor_for_groom'
    when 'поручитель' then 'sponsor'
    when 'священник' then 'clergy'
    when 'духовна особа' then 'clergy'
    when 'посадова особа' then 'official'
    when 'повитуха' then 'midwife'
    when 'особа, яка повідомила' then 'informant'
    when 'голова господарства' then 'household_head'
    when 'член господарства' then 'household_member'
    when 'наймит або служник' then 'servant'
    when 'брат' then 'possible_relative'
    when 'сестра' then 'possible_relative'
    when 'брат або сестра' then 'possible_relative'
    when 'родич' then 'possible_relative'
    when 'інше' then 'other'
    else null
  end;
$function$;

-- Keep the legacy compatibility projector's endpoint direction aligned with
-- the exact relation type.  In person_relations the card Person is stored in
-- person_id and the role holder in related_person_id for these forward roles.
create or replace function security_private.sync_context_from_person_relation_v1(
  p_relation_id uuid,
  p_delete boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  legacy_row public.person_relations%rowtype;
  normalized_relation_type text;
  type_code text;
  type_id uuid;
  context_id uuid;
  source_id uuid;
  target_id uuid;
  actor_id uuid;
  mapped_status text;
begin
  if p_delete then
    update public.context_relation_evidence evidence
    set deleted_at = coalesce(evidence.deleted_at, now()),
        deleted_by = coalesce(evidence.deleted_by, auth.uid())
    from public.person_context_relations relation
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id = p_relation_id
      and evidence.relation_id = relation.id
      and evidence.deleted_at is null;

    update public.person_context_relations relation
    set deleted_at = coalesce(relation.deleted_at, now()),
        deleted_by = coalesce(relation.deleted_by, auth.uid())
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id = p_relation_id
      and relation.deleted_at is null
    returning relation.id into context_id;
    return context_id;
  end if;

  select relation.* into legacy_row
  from public.person_relations relation
  where relation.id = p_relation_id;
  if not found then
    return security_private.sync_context_from_person_relation_v1(p_relation_id, true);
  end if;

  normalized_relation_type := lower(btrim(coalesce(legacy_row.relation_type, '')));
  type_code := security_private.legacy_person_context_type_code_v1(legacy_row.relation_type);
  if type_code is null then
    return security_private.sync_context_from_person_relation_v1(p_relation_id, true);
  end if;

  select relation_type.id into type_id
  from public.context_relation_types relation_type
  where relation_type.project_id is null
    and relation_type.code = type_code
    and relation_type.is_active;
  if type_id is null then
    raise exception 'SYSTEM_CONTEXT_RELATION_TYPE_MISSING: %', type_code using errcode = '55000';
  end if;

  if normalized_relation_type in (
    'хрещений батько', 'хрещений', 'хрещена мати', 'хрещена',
    'свідок по нареченій', 'свідок нареченої',
    'свідок зі сторони нареченої',
    'свідок по нареченому', 'свідок нареченого',
    'свідок зі сторони нареченого',
    'поручитель по нареченій', 'поручитель нареченої',
    'поручитель зі сторони нареченої',
    'поручитель по нареченому', 'поручитель нареченого',
    'поручитель зі сторони нареченого',
    'свідок', 'поручитель', 'священник', 'духовна особа',
    'посадова особа', 'повитуха', 'особа, яка повідомила',
    'голова господарства'
  ) then
    source_id := legacy_row.related_person_id;
    target_id := legacy_row.person_id;
  elsif normalized_relation_type in ('хрещеник', 'хрещениця') then
    source_id := legacy_row.person_id;
    target_id := legacy_row.related_person_id;
  else
    source_id := legacy_row.person_id;
    target_id := legacy_row.related_person_id;
  end if;

  actor_id := legacy_row.created_by;
  if actor_id is null then
    select project.owner_id into actor_id
    from public.projects project where project.id = legacy_row.project_id;
  end if;
  mapped_status := public.family_tree_evidence_status_from_legacy(legacy_row.status);

  insert into public.person_context_relations (
    project_id, relation_type_id, source_person_id, target_person_id,
    source_role_label, evidence_status, confidence, privacy_status,
    assertion_kind, notes, metadata, legacy_source_table, legacy_source_id,
    created_by, updated_by, deleted_at, deleted_by
  ) values (
    legacy_row.project_id, type_id, source_id, target_id,
    legacy_row.relation_type, mapped_status,
    public.family_tree_confidence_for_evidence(mapped_status), 'project',
    'legacy_import', legacy_row.notes,
    jsonb_build_object(
      'legacyRelationType', legacy_row.relation_type,
      'source', 'person_relations'
    ),
    'person_relations', legacy_row.id, actor_id, actor_id, null, null
  )
  on conflict (legacy_source_table, legacy_source_id) where legacy_source_id is not null
  do update set
    project_id = excluded.project_id,
    relation_type_id = excluded.relation_type_id,
    source_person_id = excluded.source_person_id,
    target_person_id = excluded.target_person_id,
    source_role_label = excluded.source_role_label,
    evidence_status = excluded.evidence_status,
    confidence = excluded.confidence,
    notes = excluded.notes,
    metadata = public.person_context_relations.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    deleted_at = null,
    deleted_by = null
  returning id into context_id;

  if btrim(coalesce(legacy_row.evidence_text, '')) <> '' then
    insert into public.context_relation_evidence (
      project_id, relation_id, evidence_kind, excerpt, notes, origin_key,
      metadata, created_by, updated_by, deleted_at, deleted_by
    ) values (
      legacy_row.project_id, context_id, 'legacy_text', legacy_row.evidence_text,
      '', 'person_relations:' || legacy_row.id::text,
      jsonb_build_object('source', 'person_relations'), actor_id, actor_id, null, null
    )
    on conflict (relation_id, origin_key) where origin_key is not null
    do update set
      excerpt = excluded.excerpt,
      metadata = public.context_relation_evidence.metadata || excluded.metadata,
      updated_by = excluded.updated_by,
      deleted_at = null,
      deleted_by = null;
  else
    update public.context_relation_evidence evidence
    set deleted_at = coalesce(evidence.deleted_at, now()),
        deleted_by = coalesce(evidence.deleted_by, actor_id)
    where evidence.relation_id = context_id
      and evidence.origin_key = 'person_relations:' || legacy_row.id::text
      and evidence.deleted_at is null;
  end if;

  return context_id;
end;
$function$;

-- Migration 016 ran its one-time projection before the exact bride/groom
-- sponsor wording existed.  Revisit only the newly understood sponsor rows so
-- existing findings and legacy person relations receive the same result as a
-- record edited after this migration.  The helpers are idempotent and preserve
-- explicit participant targets.
select security_private.backfill_finding_context_targets_v1();

do $backfill_exact_sponsor_findings$
declare finding_scope record;
begin
  for finding_scope in
    select distinct participant.finding_id, participant.project_id
    from public.finding_participants participant
    join public.findings finding
      on finding.id = participant.finding_id
     and finding.project_id = participant.project_id
    where participant.person_id is not null
      and participant.context_target_participant_id is not null
      and security_private.finding_context_type_code_v1(
        finding.finding_type,
        participant.role
      ) in ('sponsor_for_bride', 'sponsor_for_groom')
    order by participant.project_id, participant.finding_id
  loop
    perform security_private.sync_finding_context_relations_v1(
      finding_scope.finding_id,
      finding_scope.project_id
    );
  end loop;
end;
$backfill_exact_sponsor_findings$;

do $backfill_exact_sponsor_legacy_relations$
declare relation_id uuid;
begin
  for relation_id in
    select relation.id
    from public.person_relations relation
    where security_private.legacy_person_context_type_code_v1(
      relation.relation_type
    ) in ('sponsor_for_bride', 'sponsor_for_groom')
    order by relation.id
  loop
    perform security_private.sync_context_from_person_relation_v1(
      relation_id,
      false
    );
  end loop;
end;
$backfill_exact_sponsor_legacy_relations$;

create index if not exists persons_project_surname_network_idx
  on public.persons (
    project_id,
    public.person_name_search_normalize_v1(surname),
    id
  )
  where btrim(surname) <> '';

create index if not exists person_context_relations_church_source_network_idx
  on public.person_context_relations (
    project_id, source_person_id, relation_type_id, updated_at desc, id
  )
  where deleted_at is null and evidence_status <> 'disproven';

create index if not exists person_context_relations_church_target_network_idx
  on public.person_context_relations (
    project_id, target_person_id, relation_type_id, updated_at desc, id
  )
  where deleted_at is null and evidence_status <> 'disproven';

create index if not exists context_relation_evidence_network_idx
  on public.context_relation_evidence (
    relation_id, created_at desc, id
  )
  include (
    project_id, source_finding_id, source_event_id,
    citation_id, document_fragment_id, source_document_id
  )
  where deleted_at is null
    and (
      source_finding_id is not null
      or source_event_id is not null
      or citation_id is not null
      or document_fragment_id is not null
      or source_document_id is not null
    );

create or replace function security_private.list_person_church_role_network_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_role_codes text[] default null,
  p_year_from integer default null,
  p_year_to integer default null,
  p_evidence_statuses text[] default null,
  p_min_occurrences integer default 2,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  center_row public.persons%rowtype;
  center_surname_normalized text;
  center_surname_label text;
  can_edit boolean;
  requested_role_codes text[];
  requested_statuses text[];
  result jsonb;
  center_people_cap constant integer := 500;
  relation_cap constant integer := 10000;
  evidence_per_relation_cap constant integer := 50;
  occurrence_cap constant integer := 20000;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);

  if p_person_id is null then
    raise exception 'CHURCH_ROLE_NETWORK_PERSON_REQUIRED' using errcode = '22023';
  end if;
  select person.* into center_row
  from public.persons person
  where person.id = p_person_id and person.project_id = p_project_id;
  if not found then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;

  if p_year_from is not null and (p_year_from < 1 or p_year_from > 9999) then
    raise exception 'CHURCH_ROLE_NETWORK_YEAR_FROM_INVALID' using errcode = '22023';
  end if;
  if p_year_to is not null and (p_year_to < 1 or p_year_to > 9999) then
    raise exception 'CHURCH_ROLE_NETWORK_YEAR_TO_INVALID' using errcode = '22023';
  end if;
  if p_year_from is not null and p_year_to is not null and p_year_from > p_year_to then
    raise exception 'CHURCH_ROLE_NETWORK_YEAR_RANGE_INVALID' using errcode = '22023';
  end if;
  if p_min_occurrences is null or p_min_occurrences < 1 or p_min_occurrences > 1000 then
    raise exception 'CHURCH_ROLE_NETWORK_MIN_OCCURRENCES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'CHURCH_ROLE_NETWORK_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'CHURCH_ROLE_NETWORK_OFFSET_OUT_OF_RANGE' using errcode = '22023';
  end if;

  requested_role_codes := coalesce(p_role_codes, array[
    'godfather', 'godmother', 'godparent', 'sponsor',
    'sponsor_for_bride', 'sponsor_for_groom'
  ]::text[]);
  if cardinality(requested_role_codes) < 1 or cardinality(requested_role_codes) > 20
     or exists (
       select 1 from unnest(requested_role_codes) requested(code)
       where requested.code is null or requested.code not in (
         'godfather', 'godmother', 'godparent', 'sponsor',
         'sponsor_for_bride', 'sponsor_for_groom',
         'witness_for_bride', 'witness_for_groom', 'event_witness', 'witness'
       )
     ) then
    raise exception 'CHURCH_ROLE_NETWORK_ROLE_CODES_INVALID' using errcode = '22023';
  end if;
  select array_agg(distinct requested.code order by requested.code)
  into requested_role_codes
  from unnest(requested_role_codes) requested(code);

  requested_statuses := coalesce(
    p_evidence_statuses,
    array['proven', 'likely', 'unknown']::text[]
  );
  if cardinality(requested_statuses) < 1 or cardinality(requested_statuses) > 5
     or exists (
       select 1 from unnest(requested_statuses) requested(status)
       where requested.status is null or requested.status not in (
         'proven', 'likely', 'disputed', 'disproven', 'unknown'
       )
     ) then
    raise exception 'CHURCH_ROLE_NETWORK_EVIDENCE_STATUSES_INVALID' using errcode = '22023';
  end if;
  select array_agg(distinct requested.status order by requested.status)
  into requested_statuses
  from unnest(requested_statuses) requested(status);

  can_edit := coalesce(auth.role(), '') = 'service_role'
    or public.can_edit_project(p_project_id);
  if center_row.is_living
     and center_row.privacy_status in ('private', 'confidential')
     and not can_edit then
    return jsonb_build_object(
      'centerPersonId', p_person_id,
      'algorithmVersion', 'church_role_network_v1',
      'groupingKind', 'surname_cluster',
      'groupingIsGenealogicalFact', false,
      'centerGroup', null,
      'roleCodes', to_jsonb(requested_role_codes),
      'items', '[]'::jsonb,
      'total', 0,
      'sameGroupOccurrenceCount', 0,
      'omittedWithoutSurnameCount', 0,
      'truncated', false,
      'capReasons', '[]'::jsonb
    );
  end if;

  center_surname_normalized := public.person_name_search_normalize_v1(center_row.surname);
  center_surname_label := nullif(btrim(center_row.surname), '');
  if center_surname_normalized = '' or center_surname_label is null then
    return jsonb_build_object(
      'centerPersonId', p_person_id,
      'algorithmVersion', 'church_role_network_v1',
      'groupingKind', 'surname_cluster',
      'groupingIsGenealogicalFact', false,
      'centerGroup', null,
      'centerWithoutSurname', true,
      'roleCodes', to_jsonb(requested_role_codes),
      'items', '[]'::jsonb,
      'total', 0,
      'sameGroupOccurrenceCount', 0,
      'omittedWithoutSurnameCount', 0,
      'truncated', false,
      'capReasons', jsonb_build_array('center_without_surname')
    );
  end if;

  with
  center_people_candidates as materialized (
    select person.id
    from public.persons person
    where person.project_id = p_project_id
      and public.person_name_search_normalize_v1(person.surname)
        = center_surname_normalized
      and (
        can_edit
        or not (
          person.is_living
          and person.privacy_status in ('private', 'confidential')
        )
      )
    order by person.id
    limit (center_people_cap + 1)
  ),
  center_people as materialized (
    select candidate.id
    from center_people_candidates candidate
    order by candidate.id
    limit center_people_cap
  ),
  source_relation_candidates as materialized (
    select relation.id, relation.updated_at
    from center_people center_person
    join public.person_context_relations relation
      on relation.project_id = p_project_id
     and relation.source_person_id = center_person.id
     and relation.deleted_at is null
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
     and relation_type.is_active
     and relation_type.code = any(requested_role_codes)
    join public.persons source_person
      on source_person.id = relation.source_person_id
     and source_person.project_id = relation.project_id
    join public.persons target_person
      on target_person.id = relation.target_person_id
     and target_person.project_id = relation.project_id
    where relation.evidence_status = any(requested_statuses)
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not (
          (source_person.is_living and source_person.privacy_status in ('private', 'confidential'))
          or (target_person.is_living and target_person.privacy_status in ('private', 'confidential'))
        )
      )
      and (
        p_year_from is null or relation.valid_to is null
        or extract(year from relation.valid_to)::integer >= p_year_from
      )
      and (
        p_year_to is null or relation.valid_from is null
        or extract(year from relation.valid_from)::integer <= p_year_to
      )
    order by relation.updated_at desc, relation.id
    limit (relation_cap + 1)
  ),
  target_relation_candidates as materialized (
    select relation.id, relation.updated_at
    from center_people center_person
    join public.person_context_relations relation
      on relation.project_id = p_project_id
     and relation.target_person_id = center_person.id
     and relation.deleted_at is null
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
     and relation_type.is_active
     and relation_type.code = any(requested_role_codes)
    join public.persons source_person
      on source_person.id = relation.source_person_id
     and source_person.project_id = relation.project_id
    join public.persons target_person
      on target_person.id = relation.target_person_id
     and target_person.project_id = relation.project_id
    where relation.evidence_status = any(requested_statuses)
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not (
          (source_person.is_living and source_person.privacy_status in ('private', 'confidential'))
          or (target_person.is_living and target_person.privacy_status in ('private', 'confidential'))
        )
      )
      and (
        p_year_from is null or relation.valid_to is null
        or extract(year from relation.valid_to)::integer >= p_year_from
      )
      and (
        p_year_to is null or relation.valid_from is null
        or extract(year from relation.valid_from)::integer <= p_year_to
      )
    order by relation.updated_at desc, relation.id
    limit (relation_cap + 1)
  ),
  relation_candidate_ids as materialized (
    select candidate.id, max(candidate.updated_at) as updated_at
    from (
      select * from source_relation_candidates
      union all
      select * from target_relation_candidates
    ) candidate
    group by candidate.id
    order by max(candidate.updated_at) desc, candidate.id
    limit (relation_cap + 1)
  ),
  relation_ids as materialized (
    select candidate.id
    from relation_candidate_ids candidate
    order by candidate.updated_at desc, candidate.id
    limit relation_cap
  ),
  scoped_relations as materialized (
    select
      relation.id,
      relation.source_person_id,
      relation.target_person_id,
      relation.valid_from,
      relation.valid_to,
      relation.evidence_status,
      relation.confidence,
      relation.assertion_kind,
      relation.updated_at,
      relation_type.code as role_code,
      relation_type.label_uk as role_label,
      source_person.surname as source_surname,
      target_person.surname as target_surname,
      public.person_name_search_normalize_v1(source_person.surname) as source_surname_normalized,
      public.person_name_search_normalize_v1(target_person.surname) as target_surname_normalized,
      coalesce(
        nullif(btrim(source_person.full_name), ''),
        nullif(btrim(concat_ws(' ', source_person.surname, source_person.given_name, source_person.patronymic)), ''),
        'Особа'
      ) as source_display_name,
      coalesce(
        nullif(btrim(target_person.full_name), ''),
        nullif(btrim(concat_ws(' ', target_person.surname, target_person.given_name, target_person.patronymic)), ''),
        'Особа'
      ) as target_display_name,
      case
        when public.person_name_search_normalize_v1(source_person.surname) = center_surname_normalized
         and public.person_name_search_normalize_v1(target_person.surname) = center_surname_normalized
          then 'same_group'
        when public.person_name_search_normalize_v1(source_person.surname) = center_surname_normalized
          then 'outgoing'
        else 'incoming'
      end as direction,
      case
        when public.person_name_search_normalize_v1(source_person.surname) = center_surname_normalized
          then public.person_name_search_normalize_v1(target_person.surname)
        else public.person_name_search_normalize_v1(source_person.surname)
      end as counterpart_surname_normalized,
      case
        when public.person_name_search_normalize_v1(source_person.surname) = center_surname_normalized
          then nullif(btrim(target_person.surname), '')
        else nullif(btrim(source_person.surname), '')
      end as counterpart_surname_label,
      coalesce(
        extract(year from relation.valid_from)::integer,
        extract(year from relation.valid_to)::integer
      ) as relation_year
    from relation_ids selected
    join public.person_context_relations relation on relation.id = selected.id
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
    join public.persons source_person
      on source_person.id = relation.source_person_id
     and source_person.project_id = relation.project_id
    join public.persons target_person
      on target_person.id = relation.target_person_id
     and target_person.project_id = relation.project_id
  ),
  concrete_evidence_candidates as materialized (
    select
      relation.id as relation_id,
      evidence.id as evidence_id,
      evidence.source_finding_id,
      evidence.source_event_id,
      evidence.citation_id,
      evidence.document_fragment_id,
      evidence.source_document_id,
      evidence.created_at,
      evidence.evidence_rank
    from scoped_relations relation
    cross join lateral (
      select
        evidence_row.id,
        evidence_row.source_finding_id,
        evidence_row.source_event_id,
        evidence_row.citation_id,
        evidence_row.document_fragment_id,
        evidence_row.source_document_id,
        evidence_row.created_at,
        row_number() over (
          order by evidence_row.created_at desc, evidence_row.id
        ) as evidence_rank
      from public.context_relation_evidence evidence_row
      where evidence_row.relation_id = relation.id
        and evidence_row.project_id = p_project_id
        and evidence_row.deleted_at is null
        and (
          evidence_row.source_finding_id is not null
          or evidence_row.source_event_id is not null
          or evidence_row.citation_id is not null
          or evidence_row.document_fragment_id is not null
          or evidence_row.source_document_id is not null
        )
      order by evidence_row.created_at desc, evidence_row.id
      limit (evidence_per_relation_cap + 1)
    ) evidence
  ),
  bounded_evidence as materialized (
    select candidate.*
    from concrete_evidence_candidates candidate
    where candidate.evidence_rank <= evidence_per_relation_cap
  ),
  evidence_contexts as materialized (
    select
      relation.id as relation_id,
      relation.*,
      evidence.evidence_id,
      evidence.created_at as evidence_created_at,
      case
        when evidence.source_finding_id is not null then 'finding'
        when evidence.source_event_id is not null then 'event'
        when evidence.document_fragment_id is not null then 'document_fragment'
        when evidence.citation_id is not null then 'citation'
        else 'document'
      end as source_kind,
      coalesce(
        evidence.source_finding_id,
        evidence.source_event_id,
        evidence.document_fragment_id,
        evidence.citation_id,
        evidence.source_document_id
      ) as source_id,
      case
        when evidence.source_finding_id is not null then 'finding:' || evidence.source_finding_id::text
        when evidence.source_event_id is not null then 'event:' || evidence.source_event_id::text
        when evidence.document_fragment_id is not null then 'document_fragment:' || evidence.document_fragment_id::text
        when evidence.citation_id is not null then 'citation:' || evidence.citation_id::text
        else 'document:' || evidence.source_document_id::text
      end as context_key,
      coalesce(
        extract(year from security_private.historical_text_date_bound_v1(finding.event_date, true))::integer,
        extract(year from security_private.historical_text_date_bound_v1(event_row.date_from, true))::integer,
        extract(year from security_private.historical_text_date_bound_v1(event_row.event_date, true))::integer,
        extract(year from security_private.historical_text_date_bound_v1(event_row.date_text, true))::integer,
        extract(year from security_private.historical_text_date_bound_v1(document.year_from, true))::integer,
        relation.relation_year
      ) as context_year,
      case
        when not can_edit and evidence.source_finding_id is not null then 'Знахідка'
        when not can_edit and evidence.source_event_id is not null then 'Подія'
        when not can_edit and evidence.document_fragment_id is not null then 'Фрагмент документа'
        when not can_edit and evidence.citation_id is not null then 'Цитата'
        when not can_edit then 'Документ'
        when evidence.source_finding_id is not null
          then coalesce(nullif(btrim(finding.finding_type), ''), 'Знахідка')
        when evidence.source_event_id is not null
          then coalesce(nullif(btrim(event_row.title), ''), nullif(btrim(event_row.event_type), ''), 'Подія')
        when evidence.document_fragment_id is not null then 'Фрагмент документа'
        when evidence.citation_id is not null then 'Цитата'
        else coalesce(nullif(btrim(document.title), ''), 'Документ')
      end as source_label
    from bounded_evidence evidence
    join scoped_relations relation on relation.id = evidence.relation_id
    left join public.findings finding
      on finding.id = evidence.source_finding_id
     and finding.project_id = p_project_id
    left join public.person_timeline_events event_row
      on event_row.id = evidence.source_event_id
     and event_row.project_id = p_project_id
    left join public.documents document
      on document.id = evidence.source_document_id
     and document.project_id = p_project_id
  ),
  period_evidence_contexts as materialized (
    select context.*
    from evidence_contexts context
    where (
      p_year_from is null and p_year_to is null
    ) or (
      context.context_year is not null
      and (p_year_from is null or context.context_year >= p_year_from)
      and (p_year_to is null or context.context_year <= p_year_to)
    )
  ),
  period_scoped_relations as materialized (
    select relation.*
    from scoped_relations relation
    where (
      p_year_from is null and p_year_to is null
    ) or exists (
      select 1
      from period_evidence_contexts context
      where context.relation_id = relation.id
    ) or (
      (relation.valid_from is not null or relation.valid_to is not null)
      and (
        p_year_from is null or relation.valid_to is null
        or extract(year from relation.valid_to)::integer >= p_year_from
      )
      and (
        p_year_to is null or relation.valid_from is null
        or extract(year from relation.valid_from)::integer <= p_year_to
      )
    )
  ),
  deduplicated_contexts as materialized (
    select distinct on (context.relation_id, context.context_key)
      context.*
    from period_evidence_contexts context
    order by context.relation_id, context.context_key,
      context.evidence_created_at desc, context.evidence_id
  ),
  occurrence_ranked as materialized (
    select
      context.*,
      row_number() over (
        partition by
          context.source_person_id,
          context.target_person_id,
          context.role_code,
          context.context_key
        order by
          case context.assertion_kind when 'generated' then 0 else 1 end,
          context.updated_at desc,
          context.relation_id
      ) as duplicate_rank
    from deduplicated_contexts context
  ),
  occurrence_candidates as materialized (
    select occurrence.*
    from occurrence_ranked occurrence
    where occurrence.duplicate_rank = 1
    order by occurrence.updated_at desc, occurrence.relation_id, occurrence.context_key
    limit (occurrence_cap + 1)
  ),
  occurrences as materialized (
    select candidate.*
    from occurrence_candidates candidate
    order by candidate.updated_at desc, candidate.relation_id, candidate.context_key
    limit occurrence_cap
  ),
  cross_group_occurrences as materialized (
    select occurrence.*
    from occurrences occurrence
    where occurrence.direction <> 'same_group'
      and coalesce(occurrence.counterpart_surname_normalized, '') <> ''
      and occurrence.counterpart_surname_normalized <> center_surname_normalized
  ),
  relation_group_stats as materialized (
    select
      relation.counterpart_surname_normalized,
      min(relation.counterpart_surname_label) as counterpart_surname_label,
      count(distinct relation.id)::integer as relation_count,
      count(distinct (relation.source_person_id::text || ':' || relation.target_person_id::text))::integer as person_pair_count,
      count(distinct relation.source_person_id)::integer as source_person_count,
      count(distinct relation.target_person_id)::integer as target_person_count,
      count(distinct relation.id) filter (where relation.assertion_kind = 'generated')::integer as generated_count,
      count(distinct relation.id) filter (where relation.assertion_kind = 'manual')::integer as manual_count,
      count(distinct relation.id) filter (
        where relation.role_code in ('godparent', 'sponsor', 'witness')
      )::integer as ambiguous_role_count,
      min(relation.relation_year) as relation_first_year,
      max(relation.relation_year) as relation_last_year,
      max(relation.updated_at) as latest_relation_at
    from period_scoped_relations relation
    where relation.direction <> 'same_group'
      and coalesce(relation.counterpart_surname_normalized, '') <> ''
      and relation.counterpart_surname_normalized <> center_surname_normalized
    group by relation.counterpart_surname_normalized
  ),
  occurrence_group_stats as materialized (
    select
      occurrence.counterpart_surname_normalized,
      count(*)::integer as occurrence_count,
      count(*) filter (where occurrence.direction = 'incoming')::integer as incoming_count,
      count(*) filter (where occurrence.direction = 'outgoing')::integer as outgoing_count,
      min(occurrence.context_year) as occurrence_first_year,
      max(occurrence.context_year) as occurrence_last_year
    from cross_group_occurrences occurrence
    group by occurrence.counterpart_surname_normalized
  ),
  eligible_groups as materialized (
    select
      relation_group.*,
      occurrence_group.occurrence_count,
      occurrence_group.incoming_count,
      occurrence_group.outgoing_count,
      coalesce(occurrence_group.occurrence_first_year, relation_group.relation_first_year) as first_year,
      coalesce(occurrence_group.occurrence_last_year, relation_group.relation_last_year) as last_year
    from occurrence_group_stats occurrence_group
    join relation_group_stats relation_group
      on relation_group.counterpart_surname_normalized
       = occurrence_group.counterpart_surname_normalized
    where occurrence_group.occurrence_count >= p_min_occurrences
  ),
  ranked_groups as materialized (
    select group_row.*,
      row_number() over (
        order by group_row.occurrence_count desc,
          group_row.person_pair_count desc,
          group_row.counterpart_surname_normalized
      ) as group_rank
    from eligible_groups group_row
  ),
  selected_groups as materialized (
    select group_row.*
    from ranked_groups group_row
    where group_row.group_rank > p_offset
      and group_row.group_rank <= p_offset + p_limit
  ),
  cap_flags as (
    select
      (select count(*) > center_people_cap from center_people_candidates) as center_people_truncated,
      (
        (select count(*) > relation_cap from source_relation_candidates)
        or (select count(*) > relation_cap from target_relation_candidates)
        or (select count(*) > relation_cap from relation_candidate_ids)
      ) as relations_truncated,
      exists (
        select 1 from concrete_evidence_candidates evidence
        where evidence.evidence_rank > evidence_per_relation_cap
      ) as evidence_truncated,
      (select count(*) > occurrence_cap from occurrence_candidates) as occurrences_truncated,
      (select count(*) > p_offset + p_limit from ranked_groups) as pagination_truncated
  ),
  cap_state as (
    select
      flag.center_people_truncated
        or flag.relations_truncated
        or flag.evidence_truncated
        or flag.occurrences_truncated
        or flag.pagination_truncated as was_truncated,
      coalesce((
        select jsonb_agg(reason.reason order by reason.sort_order)
        from (values
          (1, 'center_people', flag.center_people_truncated),
          (2, 'relations', flag.relations_truncated),
          (3, 'evidence_per_relation', flag.evidence_truncated),
          (4, 'occurrences', flag.occurrences_truncated),
          (5, 'pagination', flag.pagination_truncated)
        ) reason(sort_order, reason, active)
        where reason.active
      ), '[]'::jsonb) as reasons
    from cap_flags flag
  )
  select jsonb_build_object(
    'centerPersonId', p_person_id,
    'algorithmVersion', 'church_role_network_v1',
    'groupingKind', 'surname_cluster',
    'groupingIsGenealogicalFact', false,
    'centerGroup', jsonb_build_object(
      'key', 'surname:' || center_surname_normalized,
      'label', center_surname_label,
      'normalizedSurname', center_surname_normalized,
      'memberCount', (select count(*) from center_people)
    ),
    'roleCodes', to_jsonb(requested_role_codes),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'counterpartGroup', jsonb_build_object(
            'key', 'surname:' || group_row.counterpart_surname_normalized,
            'label', group_row.counterpart_surname_label,
            'normalizedSurname', group_row.counterpart_surname_normalized,
            'memberCount', (
              select count(*)
              from public.persons member
              where member.project_id = p_project_id
                and public.person_name_search_normalize_v1(member.surname)
                  = group_row.counterpart_surname_normalized
                and (
                  can_edit
                  or not (
                    member.is_living
                    and member.privacy_status in ('private', 'confidential')
                  )
                )
            )
          ),
          'occurrenceCount', group_row.occurrence_count,
          'relationCount', group_row.relation_count,
          'personPairCount', group_row.person_pair_count,
          'sourcePersonCount', group_row.source_person_count,
          'targetPersonCount', group_row.target_person_count,
          'incomingCount', group_row.incoming_count,
          'outgoingCount', group_row.outgoing_count,
          'roleCounts', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'code', role_count.role_code,
                'label', role_count.role_label,
                'count', role_count.occurrence_count
              ) order by role_count.occurrence_count desc, role_count.role_code
            )
            from (
              select occurrence.role_code,
                min(occurrence.role_label) as role_label,
                count(*)::integer as occurrence_count
              from cross_group_occurrences occurrence
              where occurrence.counterpart_surname_normalized
                = group_row.counterpart_surname_normalized
              group by occurrence.role_code
            ) role_count
          ), '[]'::jsonb),
          'firstYear', group_row.first_year,
          'lastYear', group_row.last_year,
          'ambiguousRoleCount', group_row.ambiguous_role_count,
          'generatedCount', group_row.generated_count,
          'manualCount', group_row.manual_count,
          'samples', coalesce((
            select jsonb_agg(sample.payload order by sample.updated_at desc, sample.relation_id)
            from (
              select relation.id as relation_id, relation.updated_at,
                jsonb_build_object(
                  'relationId', relation.id,
                  'sourcePersonId', relation.source_person_id,
                  'sourceDisplayName', relation.source_display_name,
                  'targetPersonId', relation.target_person_id,
                  'targetDisplayName', relation.target_display_name,
                  'roleCode', relation.role_code,
                  'roleLabel', relation.role_label,
                  'direction', relation.direction,
                  'assertionKind', relation.assertion_kind,
                  'evidenceStatus', relation.evidence_status,
                  'confidence', relation.confidence,
                  'year', coalesce(source_row.context_year, relation.relation_year),
                  'evidenceCount', (
                    select count(*)
                    from public.context_relation_evidence evidence_count
                    where evidence_count.relation_id = relation.id
                      and evidence_count.project_id = p_project_id
                      and evidence_count.deleted_at is null
                  ),
                  'source', case when source_row.source_id is null then null else
                    jsonb_build_object(
                      'kind', source_row.source_kind,
                      'id', source_row.source_id,
                      'label', source_row.source_label,
                      'year', source_row.context_year
                    ) end
                ) as payload
              from period_scoped_relations relation
              left join lateral (
                select occurrence.source_kind, occurrence.source_id,
                  occurrence.source_label, occurrence.context_year
                from occurrences occurrence
                where occurrence.relation_id = relation.id
                order by occurrence.updated_at desc, occurrence.context_key
                limit 1
              ) source_row on true
              where relation.counterpart_surname_normalized
                = group_row.counterpart_surname_normalized
                and relation.direction <> 'same_group'
              order by relation.updated_at desc, relation.id
              limit 5
            ) sample
          ), '[]'::jsonb),
          'sources', coalesce((
            select jsonb_agg(source_row.payload order by source_row.updated_at desc, source_row.context_key)
            from (
              select distinct_source.*
              from (
                select distinct on (occurrence.context_key)
                  occurrence.context_key,
                  occurrence.updated_at,
                  jsonb_build_object(
                    'kind', occurrence.source_kind,
                    'id', occurrence.source_id,
                    'label', occurrence.source_label,
                    'year', occurrence.context_year
                  ) as payload
                from cross_group_occurrences occurrence
                where occurrence.counterpart_surname_normalized
                  = group_row.counterpart_surname_normalized
                order by occurrence.context_key, occurrence.updated_at desc
              ) distinct_source
              order by distinct_source.updated_at desc, distinct_source.context_key
              limit 5
            ) source_row
          ), '[]'::jsonb)
        ) order by group_row.group_rank
      )
      from selected_groups group_row
    ), '[]'::jsonb),
    'total', (select count(*) from ranked_groups),
    'sameGroupOccurrenceCount', (
      select count(*) from occurrences occurrence
      where occurrence.direction = 'same_group'
    ),
    'omittedWithoutSurnameCount', (
      select count(*) from occurrences occurrence
      where occurrence.direction <> 'same_group'
        and coalesce(occurrence.counterpart_surname_normalized, '') = ''
    ),
    'truncated', (select was_truncated from cap_state),
    'capReasons', (select reasons from cap_state)
  ) into result;

  return result;
end;
$function$;

create or replace function public.list_person_church_role_network_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_role_codes text[] default null,
  p_year_from integer default null,
  p_year_to integer default null,
  p_evidence_statuses text[] default null,
  p_min_occurrences integer default 2,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.list_person_church_role_network_v1(
    p_project_id,
    p_person_id,
    p_role_codes,
    p_year_from,
    p_year_to,
    p_evidence_statuses,
    p_min_occurrences,
    p_limit,
    p_offset
  );
$function$;

revoke all on function security_private.list_person_church_role_network_v1(
  uuid, uuid, text[], integer, integer, text[], integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.list_person_church_role_network_v1(
  uuid, uuid, text[], integer, integer, text[], integer, integer, integer
) to authenticated, service_role;

revoke all on function public.list_person_church_role_network_v1(
  uuid, uuid, text[], integer, integer, text[], integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_person_church_role_network_v1(
  uuid, uuid, text[], integer, integer, text[], integer, integer, integer
) to authenticated, service_role;

revoke all on function security_private.finding_context_type_code_v1(text, text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.finding_context_target_priority_v1(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.legacy_person_context_type_code_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_context_from_person_relation_v1(uuid, boolean)
  from public, anon, authenticated, service_role;

analyze public.context_relation_types;
analyze public.person_context_relations;
analyze public.context_relation_evidence;
analyze public.persons;

commit;
