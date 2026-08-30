begin;

-- A finding participant can optionally name the concrete participant for whom
-- their social role was performed. This is nullable for backward compatibility.
-- Steady-state synchronization never infers a missing target; a one-time legacy
-- backfill below persists a target only when there is one semantic candidate.
set local lock_timeout = '5s';
set local statement_timeout = '15min';

alter table public.finding_participants
  add column if not exists context_target_participant_id uuid;

comment on column public.finding_participants.context_target_participant_id is
  'Optional concrete participant targeted by a non-family role (for example, the child of a godfather or the bride of her witness). Must belong to the same finding and project.';

create unique index if not exists finding_participants_id_finding_project_uq
  on public.finding_participants (id, finding_id, project_id);

create index if not exists finding_participants_context_target_idx
  on public.finding_participants (project_id, finding_id, context_target_participant_id)
  where context_target_participant_id is not null;

do $context_target_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_context_target_fkey'
  ) then
    alter table public.finding_participants
      add constraint finding_participants_context_target_fkey
      foreign key (context_target_participant_id, finding_id, project_id)
      references public.finding_participants(id, finding_id, project_id)
      on delete set null (context_target_participant_id)
      deferrable initially deferred;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_context_target_not_self'
  ) then
    alter table public.finding_participants
      add constraint finding_participants_context_target_not_self
      check (
        context_target_participant_id is null
        or context_target_participant_id <> id
      );
  end if;
end;
$context_target_constraints$;

-- finding_participants becomes a first-class generated provenance source. The
-- prior constraint was intentionally closed to unknown source tables, so replace
-- only that specific check and preserve all unrelated checks.
do $finding_context_legacy_origin_constraint$
declare
  constraint_name text;
begin
  for constraint_name in
    select constraint_row.conname
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.person_context_relations'::regclass
      and constraint_row.contype = 'c'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) ilike '%legacy_source_table%'
  loop
    execute format(
      'alter table public.person_context_relations drop constraint %I',
      constraint_name
    );
  end loop;

  alter table public.person_context_relations
    add constraint person_context_relations_legacy_source_check
    check (
      (legacy_source_table is null and legacy_source_id is null)
      or (
        legacy_source_table in (
          'association_relationships',
          'person_relations',
          'finding_participants'
        )
        and legacy_source_id is not null
      )
    );
end;
$finding_context_legacy_origin_constraint$;

-- The old `witness` code is retained only for ambiguous legacy records and is
-- described by clients as a wedding role needing clarification. A generic
-- witness in a non-marriage finding is semantically different, so give it a
-- precise event-level type instead of reusing that legacy ambiguity.
insert into public.context_relation_types as existing_type (
  code, category, directionality, label_uk, inverse_code, inverse_label_uk,
  source_role_uk, target_role_uk, icon_token, color_role, is_system, metadata
)
values (
  'event_witness', 'documentary', 'directed', 'Свідок при події',
  'event_participant_witnessed_by', 'Особа, для якої свідчили при події',
  'Свідок при події', 'Учасник події', 'witness', 'documentary', true,
  jsonb_build_object(
    'specificPersonRole', true,
    'sourceEndpoint', 'event_witness',
    'targetEndpoint', 'event_participant',
    'findingGenerated', true
  )
)
on conflict (lower(code)) where project_id is null do update
set category = excluded.category,
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
  existing_type.category, existing_type.directionality,
  existing_type.label_uk, existing_type.inverse_code,
  existing_type.inverse_label_uk, existing_type.source_role_uk,
  existing_type.target_role_uk, existing_type.icon_token,
  existing_type.color_role, existing_type.is_system,
  existing_type.is_active, existing_type.metadata
) is distinct from row(
  excluded.category, excluded.directionality,
  excluded.label_uk, excluded.inverse_code,
  excluded.inverse_label_uk, excluded.source_role_uk,
  excluded.target_role_uk, excluded.icon_token,
  excluded.color_role, true, true,
  existing_type.metadata || excluded.metadata
);

create or replace function security_private.normalize_finding_participant_role_v1(
  p_value text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select lower(regexp_replace(btrim(coalesce($1, '')), '[[:space:]]+', ' ', 'g'));
$function$;

create or replace function security_private.finding_kind_for_context_v1(
  p_finding_type text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, security_private
as $function$
  select case
    when security_private.normalize_finding_participant_role_v1($1)
      ~ '(народ|хрещ|birth|bapt)' then 'birth'
    when security_private.normalize_finding_participant_role_v1($1)
      ~ '(шлюб|вінчан|marriage|wedding)' then 'marriage'
    when security_private.normalize_finding_participant_role_v1($1)
      ~ '(смерт|помер|похов|death|burial)' then 'death'
    when security_private.normalize_finding_participant_role_v1($1)
      ~ '(посімейн|погосподар|сповід|ревіз|перепис|інвентар|household|census|revision)' then 'household'
    else 'other'
  end;
$function$;

-- Map only roles whose social meaning is explicit. Family roles and generic
-- "other person" wording deliberately return NULL. A generic marriage witness
-- is also rejected: the bride/groom side must be stated explicitly.
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
  if normalized_role in (
    'опікун', 'піклувальник', 'guardian'
  ) then return 'guardian_non_parent'; end if;
  if normalized_role in (
    'сусід', 'сусідка', 'neighbor'
  ) then return 'neighbor'; end if;
  return null;
end;
$function$;

comment on function security_private.finding_context_type_code_v1(text, text) is
  'Fail-closed mapping from a structured finding participant role to a non-family context relation type. Generic marriage witnesses are intentionally ambiguous.';

-- Lower values are more semantically specific. Synchronization uses only the
-- best-priority group and proceeds when that group contains exactly one target.
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
  if p_context_type_code is null then
    return null;
  end if;

  if p_context_type_code in ('godfather', 'godmother', 'midwife') then
    if normalized_role in (
      'дитина', 'новонароджений', 'новонароджена', 'охрещений',
      'охрещена', 'народжений', 'народжена', 'child', 'newborn', 'baptized'
    ) then return 0; end if;
    return null;
  end if;

  if p_context_type_code = 'witness_for_bride' then
    if finding_kind = 'marriage'
       and normalized_role in ('наречена', 'молода', 'bride') then return 0; end if;
    return null;
  end if;

  if p_context_type_code = 'witness_for_groom' then
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
    -- A main person is only a fallback when no explicit ward is present.
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
    -- Sponsor/clergy/official roles may concern either spouse. With both spouses
    -- present this deliberately remains ambiguous unless an explicit target was
    -- chosen in context_target_participant_id.
    if normalized_role in ('наречений', 'молодий', 'groom', 'наречена', 'молода', 'bride')
      then return 0;
    end if;
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

create or replace function security_private.delete_context_from_finding_participant_v1(
  p_participant_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  context_id uuid;
  actor_id uuid := auth.uid();
begin
  select relation.id
  into context_id
  from public.person_context_relations relation
  where relation.legacy_source_table = 'finding_participants'
    and relation.legacy_source_id = p_participant_id;

  if context_id is null then return null; end if;

  update public.context_relation_evidence evidence
  set deleted_at = now(),
      deleted_by = coalesce(actor_id, evidence.updated_by, evidence.created_by)
  where evidence.relation_id = context_id
    and evidence.origin_key = 'finding_participant:' || p_participant_id::text
    and evidence.deleted_at is null;

  update public.person_context_relations relation
  set deleted_at = now(),
      deleted_by = coalesce(actor_id, relation.updated_by, relation.created_by)
  where relation.id = context_id
    and relation.deleted_at is null;

  return context_id;
end;
$function$;

create or replace function security_private.sync_context_from_finding_participant_v1(
  p_participant_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  source_row public.finding_participants%rowtype;
  target_row public.finding_participants%rowtype;
  finding_row public.findings%rowtype;
  type_row public.context_relation_types%rowtype;
  type_code text;
  context_id uuid;
  actor_id uuid;
  relation_privacy text;
  evidence_origin_key text := 'finding_participant:' || p_participant_id::text;
  relation_metadata jsonb;
  evidence_metadata jsonb;
begin
  select participant.*
  into source_row
  from public.finding_participants participant
  where participant.id = p_participant_id;

  if not found or source_row.person_id is null then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  select finding.*
  into finding_row
  from public.findings finding
  where finding.id = source_row.finding_id
    and finding.project_id = source_row.project_id;

  if not found then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  type_code := security_private.finding_context_type_code_v1(
    finding_row.finding_type,
    source_row.role
  );
  if type_code is null then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  select relation_type.*
  into type_row
  from public.context_relation_types relation_type
  where relation_type.project_id is null
    and relation_type.code = type_code
    and relation_type.is_active;

  if not found then
    raise exception 'SYSTEM_CONTEXT_RELATION_TYPE_MISSING: %', type_code
      using errcode = '55000';
  end if;

  -- Steady-state synchronization never guesses a missing target. The app stores
  -- its only safe candidate explicitly; the migration-only backfill below does
  -- the same once for legacy rows. Consequently deleting an explicit target
  -- archives the relation instead of silently retargeting another participant.
  if source_row.context_target_participant_id is null then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  select participant.*
  into target_row
  from public.finding_participants participant
  where participant.id = source_row.context_target_participant_id
    and participant.finding_id = source_row.finding_id
    and participant.project_id = source_row.project_id
    and participant.person_id is not null;
  if not found or security_private.finding_context_target_priority_v1(
    finding_row.finding_type,
    type_code,
    target_row.role
  ) is null then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  if target_row.person_id is null or target_row.person_id = source_row.person_id then
    return security_private.delete_context_from_finding_participant_v1(p_participant_id);
  end if;

  select case
    when bool_or(person.privacy_status = 'confidential') then 'confidential'
    when bool_or(person.privacy_status = 'private') then 'private'
    else 'project'
  end
  into relation_privacy
  from public.persons person
  where person.project_id = source_row.project_id
    and person.id in (source_row.person_id, target_row.person_id);

  actor_id := coalesce(auth.uid(), finding_row.created_by);
  if actor_id is null then
    select project.owner_id into actor_id
    from public.projects project where project.id = source_row.project_id;
  end if;

  relation_metadata := jsonb_build_object(
    'source', 'finding_participant_sync_v1',
    'managedByFindingParticipantSync', true,
    'findingId', finding_row.id,
    'sourceParticipantId', source_row.id,
    'targetParticipantId', target_row.id,
    'contextTypeCode', type_code,
    'sourceFindingRole', source_row.role,
    'targetFindingRole', target_row.role,
    'algorithm', 'finding_participant_sync_v1'
  );

  insert into public.person_context_relations (
    project_id, relation_type_id, source_person_id, target_person_id,
    source_role_label, target_role_label, valid_from, valid_to, period_text,
    evidence_status, confidence, privacy_status, assertion_kind,
    notes, metadata, legacy_source_table, legacy_source_id,
    created_by, updated_by, deleted_at, deleted_by
  ) values (
    source_row.project_id, type_row.id, source_row.person_id, target_row.person_id,
    type_row.source_role_uk, type_row.target_role_uk,
    security_private.historical_text_date_bound_v1(finding_row.event_date, false),
    security_private.historical_text_date_bound_v1(finding_row.event_date, true),
    finding_row.event_date,
    'unknown', 50, relation_privacy, 'generated',
    'Сформовано автоматично зі структурованих учасників знахідки.',
    relation_metadata, 'finding_participants', source_row.id,
    actor_id, actor_id, null, null
  )
  on conflict (legacy_source_table, legacy_source_id) where legacy_source_id is not null
  do update set
    relation_type_id = excluded.relation_type_id,
    source_person_id = excluded.source_person_id,
    target_person_id = excluded.target_person_id,
    source_role_label = excluded.source_role_label,
    target_role_label = excluded.target_role_label,
    valid_from = excluded.valid_from,
    valid_to = excluded.valid_to,
    period_text = excluded.period_text,
    privacy_status = excluded.privacy_status,
    notes = excluded.notes,
    metadata = public.person_context_relations.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    deleted_at = null,
    deleted_by = null
  where row(
    public.person_context_relations.relation_type_id,
    public.person_context_relations.source_person_id,
    public.person_context_relations.target_person_id,
    public.person_context_relations.source_role_label,
    public.person_context_relations.target_role_label,
    public.person_context_relations.valid_from,
    public.person_context_relations.valid_to,
    public.person_context_relations.period_text,
    public.person_context_relations.privacy_status,
    public.person_context_relations.notes,
    public.person_context_relations.metadata,
    public.person_context_relations.deleted_at,
    public.person_context_relations.deleted_by
  ) is distinct from row(
    excluded.relation_type_id,
    excluded.source_person_id,
    excluded.target_person_id,
    excluded.source_role_label,
    excluded.target_role_label,
    excluded.valid_from,
    excluded.valid_to,
    excluded.period_text,
    excluded.privacy_status,
    excluded.notes,
    public.person_context_relations.metadata || excluded.metadata,
    null::timestamptz,
    null::uuid
  )
  returning id into context_id;

  if context_id is null then
    select relation.id
    into context_id
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = source_row.id;
  end if;

  -- Keep a durable, non-sensitive locator. It preserves the evidence CHECK even
  -- after finding/participant FKs are SET NULL during cascade deletion, without
  -- copying private transcription, notes or archival content into the graph.
  evidence_metadata := jsonb_build_object(
    'source', 'finding_participant_sync_v1',
    'findingId', finding_row.id,
    'sourceParticipantId', source_row.id,
    'targetParticipantId', target_row.id,
    'contextTypeCode', type_code
  );

  insert into public.context_relation_evidence (
    project_id, relation_id, evidence_kind,
    source_document_id, source_finding_id, finding_participant_id,
    source_locator, excerpt, notes, origin_key, metadata,
    created_by, updated_by, deleted_at, deleted_by
  ) values (
    source_row.project_id, context_id, 'finding',
    finding_row.document_id, finding_row.id, source_row.id,
    'finding:' || finding_row.id::text, '', '', evidence_origin_key, evidence_metadata,
    actor_id, actor_id, null, null
  )
  on conflict (relation_id, origin_key) where origin_key is not null
  do update set
    source_document_id = excluded.source_document_id,
    source_finding_id = excluded.source_finding_id,
    finding_participant_id = excluded.finding_participant_id,
    source_locator = excluded.source_locator,
    excerpt = excluded.excerpt,
    notes = excluded.notes,
    metadata = public.context_relation_evidence.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    deleted_at = null,
    deleted_by = null
  where row(
    public.context_relation_evidence.source_document_id,
    public.context_relation_evidence.source_finding_id,
    public.context_relation_evidence.finding_participant_id,
    public.context_relation_evidence.source_locator,
    public.context_relation_evidence.excerpt,
    public.context_relation_evidence.notes,
    public.context_relation_evidence.metadata,
    public.context_relation_evidence.deleted_at,
    public.context_relation_evidence.deleted_by
  ) is distinct from row(
    excluded.source_document_id,
    excluded.source_finding_id,
    excluded.finding_participant_id,
    excluded.source_locator,
    excluded.excerpt,
    excluded.notes,
    public.context_relation_evidence.metadata || excluded.metadata,
    null::timestamptz,
    null::uuid
  );

  -- Older clients also projected an automatically created person_relations row
  -- for this pair. That row has no finding_id and therefore cannot replace the
  -- per-finding assertion/evidence created above: two different findings may
  -- legitimately describe the same people and role. Once the lossless
  -- finding-generated origin exists, archive only the exact old auto projection.
  -- If it carries any active evidence, keep the legacy assertion visible: such
  -- evidence cannot safely be assigned to one of potentially several findings.
  -- The source person_relations row, manual assertions, evidence text that merely
  -- resembles the marker, reversed endpoints and generic-vs-precise type
  -- mismatches are deliberately untouched.
  update public.person_context_relations legacy_projection
  set deleted_at = coalesce(legacy_projection.deleted_at, now()),
      deleted_by = coalesce(legacy_projection.deleted_by, actor_id),
      updated_by = coalesce(actor_id, legacy_projection.updated_by, legacy_projection.created_by)
  from public.person_relations legacy_source
  where legacy_source.id = legacy_projection.legacy_source_id
    and legacy_source.project_id = legacy_projection.project_id
    and legacy_projection.project_id = source_row.project_id
    and legacy_projection.assertion_kind = 'legacy_import'
    and legacy_projection.legacy_source_table = 'person_relations'
    and legacy_projection.relation_type_id = type_row.id
    and legacy_projection.source_person_id = source_row.person_id
    and legacy_projection.target_person_id = target_row.person_id
    and legacy_projection.deleted_at is null
    and legacy_source.notes = 'Створено автоматично зі знахідки після створення пов’язаних осіб.'
    and not exists (
      select 1
      from public.context_relation_evidence legacy_evidence
      where legacy_evidence.relation_id = legacy_projection.id
        and legacy_evidence.deleted_at is null
    );

  return context_id;
end;
$function$;

create or replace function security_private.sync_finding_context_relations_v1(
  p_finding_id uuid,
  p_project_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  participant_id uuid;
  synchronized_count integer := 0;
begin
  -- Reconcile every current participant once. This is statement-batched by the
  -- transition-table triggers below, avoiding one full scan per inserted row.
  for participant_id in
    select participant.id
    from public.finding_participants participant
    where participant.finding_id = p_finding_id
      and participant.project_id = p_project_id
    order by participant.id
  loop
    if security_private.sync_context_from_finding_participant_v1(participant_id) is not null then
      synchronized_count := synchronized_count + 1;
    end if;
  end loop;
  return synchronized_count;
end;
$function$;

create or replace function security_private.sync_finding_context_after_insert_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct inserted.finding_id, inserted.project_id
    from inserted_rows inserted
  loop
    perform security_private.sync_finding_context_relations_v1(
      changed.finding_id,
      changed.project_id
    );
  end loop;
  return null;
end;
$function$;

create or replace function security_private.sync_finding_context_after_update_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct affected.finding_id, affected.project_id
    from (
      select old_row.finding_id, old_row.project_id from old_rows old_row
      union
      select new_row.finding_id, new_row.project_id from new_rows new_row
    ) affected
  loop
    perform security_private.sync_finding_context_relations_v1(
      changed.finding_id,
      changed.project_id
    );
  end loop;
  return null;
end;
$function$;

create or replace function security_private.sync_finding_context_after_delete_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  changed record;
  removed_id uuid;
begin
  for removed_id in select deleted.id from deleted_rows deleted loop
    perform security_private.delete_context_from_finding_participant_v1(removed_id);
  end loop;

  for changed in
    select distinct deleted.finding_id, deleted.project_id
    from deleted_rows deleted
  loop
    perform security_private.sync_finding_context_relations_v1(
      changed.finding_id,
      changed.project_id
    );
  end loop;
  return null;
end;
$function$;

create or replace function security_private.sync_finding_context_after_finding_update_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct updated.id, updated.project_id
    from updated_findings updated
  loop
    perform security_private.sync_finding_context_relations_v1(
      changed.id,
      changed.project_id
    );
  end loop;
  return null;
end;
$function$;

create or replace function security_private.cleanup_finding_context_before_delete_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  -- Clear both nullable provenance FKs while Finding and participants still
  -- exist. PostgreSQL may otherwise execute the two SET NULL cascades in either
  -- order, and the evidence validation trigger would briefly see a dangling
  -- participant reference. source_locator remains the durable provenance key.
  update public.context_relation_evidence evidence
  set source_finding_id = null,
      finding_participant_id = null,
      deleted_at = coalesce(evidence.deleted_at, now()),
      deleted_by = coalesce(evidence.deleted_by, auth.uid(), evidence.updated_by, evidence.created_by)
  from public.person_context_relations relation
  where evidence.relation_id = relation.id
    and evidence.source_finding_id = old.id
    and relation.legacy_source_table = 'finding_participants'
    and relation.metadata ->> 'findingId' = old.id::text;

  update public.person_context_relations relation
  set deleted_at = coalesce(relation.deleted_at, now()),
      deleted_by = coalesce(relation.deleted_by, auth.uid(), relation.updated_by, relation.created_by)
  where relation.legacy_source_table = 'finding_participants'
    and relation.metadata ->> 'findingId' = old.id::text;
  return old;
end;
$function$;

create or replace function security_private.sync_finding_context_after_person_update_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare changed record;
begin
  for changed in
    select distinct participant.finding_id, participant.project_id
    from new_person_rows new_person
    join old_person_rows old_person on old_person.id = new_person.id
    join public.finding_participants participant
      on participant.person_id = new_person.id
     and participant.project_id = new_person.project_id
    where new_person.privacy_status is distinct from old_person.privacy_status
  loop
    perform security_private.sync_finding_context_relations_v1(
      changed.finding_id,
      changed.project_id
    );
  end loop;
  return null;
end;
$function$;

drop trigger if exists finding_participants_80_context_sync_insert
  on public.finding_participants;
create trigger finding_participants_80_context_sync_insert
after insert on public.finding_participants
referencing new table as inserted_rows
for each statement execute function security_private.sync_finding_context_after_insert_v1();

drop trigger if exists finding_participants_80_context_sync_update
  on public.finding_participants;
create trigger finding_participants_80_context_sync_update
after update on public.finding_participants
referencing old table as old_rows new table as new_rows
for each statement execute function security_private.sync_finding_context_after_update_v1();

drop trigger if exists finding_participants_80_context_sync_delete
  on public.finding_participants;
create trigger finding_participants_80_context_sync_delete
after delete on public.finding_participants
referencing old table as deleted_rows
for each statement execute function security_private.sync_finding_context_after_delete_v1();

drop trigger if exists findings_80_context_sync_update on public.findings;
create trigger findings_80_context_sync_update
after update on public.findings
referencing new table as updated_findings
for each statement execute function security_private.sync_finding_context_after_finding_update_v1();

drop trigger if exists findings_05_context_cleanup_delete on public.findings;
create trigger findings_05_context_cleanup_delete
before delete on public.findings
for each row execute function security_private.cleanup_finding_context_before_delete_v1();

drop trigger if exists persons_80_finding_context_privacy_sync_update
  on public.persons;
create trigger persons_80_finding_context_privacy_sync_update
after update on public.persons
referencing old table as old_person_rows new table as new_person_rows
for each statement execute function security_private.sync_finding_context_after_person_update_v1();

-- A later write by an old client re-runs the legacy projector from migration
-- 015 and clears deleted_at. Keep an evidence-free exact auto projection
-- archived when a lossless finding-generated origin for the same directed edge
-- already exists. PostgreSQL orders triggers of the same kind by name, so this
-- `_z_` trigger runs after person_relations_context_graph_sync.
create or replace function security_private.suppress_auto_person_relation_projection_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare actor_id uuid := coalesce(auth.uid(), new.created_by);
begin
  if new.notes <> 'Створено автоматично зі знахідки після створення пов’язаних осіб.' then
    return new;
  end if;

  update public.person_context_relations legacy_projection
  set deleted_at = coalesce(legacy_projection.deleted_at, now()),
      deleted_by = coalesce(legacy_projection.deleted_by, actor_id),
      updated_by = coalesce(actor_id, legacy_projection.updated_by, legacy_projection.created_by)
  where legacy_projection.project_id = new.project_id
    and legacy_projection.assertion_kind = 'legacy_import'
    and legacy_projection.legacy_source_table = 'person_relations'
    and legacy_projection.legacy_source_id = new.id
    and legacy_projection.deleted_at is null
    and not exists (
      select 1
      from public.context_relation_evidence legacy_evidence
      where legacy_evidence.relation_id = legacy_projection.id
        and legacy_evidence.deleted_at is null
    )
    and exists (
      select 1
      from public.person_context_relations generated_relation
      join public.context_relation_evidence generated_evidence
        on generated_evidence.relation_id = generated_relation.id
       and generated_evidence.deleted_at is null
       and generated_evidence.origin_key like 'finding_participant:%'
      where generated_relation.project_id = legacy_projection.project_id
        and generated_relation.assertion_kind = 'generated'
        and generated_relation.legacy_source_table = 'finding_participants'
        and generated_relation.relation_type_id = legacy_projection.relation_type_id
        and generated_relation.source_person_id = legacy_projection.source_person_id
        and generated_relation.target_person_id = legacy_projection.target_person_id
        and generated_relation.deleted_at is null
        and generated_relation.metadata ->> 'source' = 'finding_participant_sync_v1'
        and generated_evidence.metadata ->> 'source' = 'finding_participant_sync_v1'
    );

  return new;
end;
$function$;

drop trigger if exists person_relations_context_graph_z_dedupe
  on public.person_relations;
create trigger person_relations_context_graph_z_dedupe
after insert or update of
  person_id, related_person_id, relation_type, status, evidence_text, notes
on public.person_relations
for each row execute function security_private.suppress_auto_person_relation_projection_v1();

-- Generated relations are projections of another source of truth. They may be
-- archived only by their synchronizer, never through the public manual archive
-- RPC. Manual, research-hypothesis and legacy-import assertions keep the prior
-- optimistic-locking behavior.
create or replace function security_private.archive_person_context_relation_v1(
  p_project_id uuid,
  p_relation_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  existing public.person_context_relations%rowtype;
  saved public.person_context_relations%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_expected_lock_version is null then
    raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;

  select relation.*
  into existing
  from public.person_context_relations relation
  where relation.id = p_relation_id
    and relation.project_id = p_project_id
    and relation.deleted_at is null
  for update;

  if not found or existing.lock_version <> p_expected_lock_version then
    raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001';
  end if;
  if existing.assertion_kind = 'generated' then
    raise exception 'CONTEXT_RELATION_GENERATED_READ_ONLY' using errcode = '22023';
  end if;

  update public.person_context_relations relation
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where relation.id = existing.id
    and relation.lock_version = p_expected_lock_version
  returning * into saved;
  if not found then
    raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001';
  end if;

  update public.context_relation_evidence evidence
  set deleted_at = coalesce(evidence.deleted_at, now()),
      deleted_by = coalesce(evidence.deleted_by, auth.uid()),
      updated_by = auth.uid()
  where evidence.relation_id = saved.id
    and evidence.deleted_at is null;
  return security_private.context_relation_json_v1(saved, false);
end;
$function$;

-- The synchronizer owns its provenance evidence row. Editors may attach a
-- separate manual evidence item to a generated relation, but the public RPCs
-- must not rewrite or archive the finding_participant:* origin itself.
create or replace function security_private.is_managed_finding_context_evidence_v1(
  p_project_id uuid,
  p_evidence_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select exists (
    select 1
    from public.context_relation_evidence evidence
    join public.person_context_relations relation
      on relation.id = evidence.relation_id
     and relation.project_id = evidence.project_id
    where evidence.id = p_evidence_id
      and evidence.project_id = p_project_id
      and evidence.origin_key like 'finding_participant:%'
      and evidence.metadata ->> 'source' = 'finding_participant_sync_v1'
      and relation.assertion_kind = 'generated'
      and relation.legacy_source_table = 'finding_participants'
      and relation.metadata ->> 'source' = 'finding_participant_sync_v1'
      and relation.metadata @> '{"managedByFindingParticipantSync":true}'::jsonb
  );
$function$;

create or replace function security_private.save_context_relation_evidence_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  target_id uuid;
  target_relation_id uuid;
  saved public.context_relation_evidence%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 200000 then
    raise exception 'CONTEXT_EVIDENCE_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  target_id := nullif(p_payload ->> 'id', '')::uuid;
  target_relation_id := nullif(p_payload ->> 'relationId', '')::uuid;
  if target_relation_id is null then
    raise exception 'CONTEXT_RELATION_ID_REQUIRED' using errcode = '22023';
  end if;

  if target_id is not null
     and security_private.is_managed_finding_context_evidence_v1(
       p_project_id,
       target_id
     ) then
    raise exception 'CONTEXT_EVIDENCE_GENERATED_READ_ONLY' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.person_context_relations relation
    where relation.id = target_relation_id
      and relation.project_id = p_project_id
      and relation.deleted_at is null
  ) then
    raise exception 'CONTEXT_RELATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if target_id is null then
    insert into public.context_relation_evidence (
      project_id, relation_id, evidence_kind, source_document_id,
      source_finding_id, source_event_id, finding_participant_id,
      citation_id, document_fragment_id, source_locator, excerpt, notes,
      metadata, created_by, updated_by
    ) values (
      p_project_id, target_relation_id,
      coalesce(nullif(p_payload ->> 'evidenceKind', ''), 'note'),
      nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
      nullif(p_payload ->> 'sourceFindingId', '')::uuid,
      nullif(p_payload ->> 'sourceEventId', '')::uuid,
      nullif(p_payload ->> 'findingParticipantId', '')::uuid,
      nullif(p_payload ->> 'citationId', '')::uuid,
      nullif(p_payload ->> 'documentFragmentId', '')::uuid,
      btrim(coalesce(p_payload ->> 'sourceLocator', '')),
      btrim(coalesce(p_payload ->> 'excerpt', '')),
      btrim(coalesce(p_payload ->> 'notes', '')),
      coalesce(p_payload -> 'metadata', '{}'::jsonb), auth.uid(), auth.uid()
    ) returning * into saved;
  else
    if p_expected_lock_version is null then
      raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
    end if;
    update public.context_relation_evidence evidence
    set
      evidence_kind = coalesce(nullif(p_payload ->> 'evidenceKind', ''), 'note'),
      source_document_id = nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
      source_finding_id = nullif(p_payload ->> 'sourceFindingId', '')::uuid,
      source_event_id = nullif(p_payload ->> 'sourceEventId', '')::uuid,
      finding_participant_id = nullif(p_payload ->> 'findingParticipantId', '')::uuid,
      citation_id = nullif(p_payload ->> 'citationId', '')::uuid,
      document_fragment_id = nullif(p_payload ->> 'documentFragmentId', '')::uuid,
      source_locator = btrim(coalesce(p_payload ->> 'sourceLocator', '')),
      excerpt = btrim(coalesce(p_payload ->> 'excerpt', '')),
      notes = btrim(coalesce(p_payload ->> 'notes', '')),
      metadata = coalesce(p_payload -> 'metadata', '{}'::jsonb),
      updated_by = auth.uid()
    where evidence.id = target_id
      and evidence.project_id = p_project_id
      and evidence.relation_id = target_relation_id
      and evidence.deleted_at is null
      and evidence.lock_version = p_expected_lock_version
    returning * into saved;
    if not found then
      raise exception 'CONTEXT_EVIDENCE_STALE_OR_NOT_FOUND' using errcode = '40001';
    end if;
  end if;
  return security_private.context_relation_evidence_json_v1(saved);
end;
$function$;

create or replace function security_private.archive_context_relation_evidence_v1(
  p_project_id uuid,
  p_evidence_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare saved public.context_relation_evidence%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_expected_lock_version is null then
    raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;
  if security_private.is_managed_finding_context_evidence_v1(
    p_project_id,
    p_evidence_id
  ) then
    raise exception 'CONTEXT_EVIDENCE_GENERATED_READ_ONLY' using errcode = '22023';
  end if;

  update public.context_relation_evidence evidence
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where evidence.id = p_evidence_id
    and evidence.project_id = p_project_id
    and evidence.deleted_at is null
    and evidence.lock_version = p_expected_lock_version
  returning * into saved;
  if not found then
    raise exception 'CONTEXT_EVIDENCE_STALE_OR_NOT_FOUND' using errcode = '40001';
  end if;
  return security_private.context_relation_evidence_json_v1(saved);
end;
$function$;

revoke all on function security_private.is_managed_finding_context_evidence_v1(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Persist the target for legacy structured rows only when the best semantic
-- candidate is unique. Rows that have ever produced a generated relation are
-- excluded, including soft-deleted origins: re-running this migration after an
-- explicit target was deleted must never silently retarget the source.
create or replace function security_private.backfill_finding_context_targets_v1()
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare updated_count integer;
begin
  with candidate as (
    select
      source.id as source_participant_id,
      target.id as target_participant_id,
      priority.value as target_priority
    from public.finding_participants source
    join public.findings finding
      on finding.id = source.finding_id
     and finding.project_id = source.project_id
    join public.finding_participants target
      on target.finding_id = source.finding_id
     and target.project_id = source.project_id
     and target.id <> source.id
     and target.person_id is not null
     and target.person_id <> source.person_id
    cross join lateral (
      select security_private.finding_context_type_code_v1(
        finding.finding_type,
        source.role
      ) as value
    ) context_type_code
    cross join lateral (
      select security_private.finding_context_target_priority_v1(
        finding.finding_type,
        context_type_code.value,
        target.role
      ) as value
    ) priority
    where source.person_id is not null
      and source.context_target_participant_id is null
      and context_type_code.value is not null
      and priority.value is not null
      and not exists (
        select 1
        from public.person_context_relations relation
        where relation.legacy_source_table = 'finding_participants'
          and relation.legacy_source_id = source.id
      )
  ), ranked_candidate as (
    select
      candidate.*,
      min(candidate.target_priority) over (
        partition by candidate.source_participant_id
      ) as best_priority
    from candidate
  ), unique_best_candidate as (
    select
      ranked_candidate.source_participant_id,
      (array_agg(ranked_candidate.target_participant_id))[1] as target_participant_id
    from ranked_candidate
    where ranked_candidate.target_priority = ranked_candidate.best_priority
    group by ranked_candidate.source_participant_id
    having count(*) = 1
  )
  update public.finding_participants source
  set context_target_participant_id = unique_best_candidate.target_participant_id
  from unique_best_candidate
  where source.id = unique_best_candidate.source_participant_id
    and source.context_target_participant_id is null;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$function$;

revoke all on function security_private.backfill_finding_context_targets_v1()
  from public, anon, authenticated, service_role;

select security_private.backfill_finding_context_targets_v1();

-- Existing structured findings with a persisted target receive the same
-- behavior once. Normal graph triggers stay enabled: idempotent upserts bump
-- revisions only for rows that were actually inserted or changed.
do $backfill_finding_context_relations$
declare finding_scope record;
begin
  for finding_scope in
    select distinct participant.finding_id, participant.project_id
    from public.finding_participants participant
    join public.findings finding
      on finding.id = participant.finding_id
     and finding.project_id = participant.project_id
    where participant.person_id is not null
      and security_private.finding_context_type_code_v1(
        finding.finding_type,
        participant.role
      ) is not null
    order by participant.project_id, participant.finding_id
  loop
    perform security_private.sync_finding_context_relations_v1(
      finding_scope.finding_id,
      finding_scope.project_id
    );
  end loop;
end;
$backfill_finding_context_relations$;

revoke all on function security_private.normalize_finding_participant_role_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.finding_kind_for_context_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.finding_context_type_code_v1(text, text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.finding_context_target_priority_v1(text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.backfill_finding_context_targets_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.delete_context_from_finding_participant_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_context_from_finding_participant_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_relations_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_insert_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_update_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_delete_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_finding_update_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.cleanup_finding_context_before_delete_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.sync_finding_context_after_person_update_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.suppress_auto_person_relation_projection_v1()
  from public, anon, authenticated, service_role;

analyze public.finding_participants;
analyze public.person_context_relations;
analyze public.context_relation_evidence;

commit;
