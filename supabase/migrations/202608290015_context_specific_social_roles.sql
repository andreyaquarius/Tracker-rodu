begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

-- Keep the original generic `godparent` and `witness` types active for old
-- assertions whose source does not identify a more precise role. New manual
-- assertions can use one of the four explicit directed roles below. In every
-- case source_person_id is the person performing the role and target_person_id
-- is the concrete godchild or marriage participant for whom the role was
-- performed. Wedding side is a property of the witness role, not an inferred
-- sex/role of the target Person; evidence may later link the shared event.
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
    'godfather',
    'church',
    'directed',
    'Хрещений батько',
    'godchild_of_godfather',
    'Хрещеник або хрещениця хрещеного батька',
    'Хрещений батько',
    'Хрещеник або хрещениця',
    'church',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'godfather',
      'targetEndpoint', 'godchild',
      'genericFallbackCode', 'godparent'
    )
  ),
  (
    'godmother',
    'church',
    'directed',
    'Хрещена мати',
    'godchild_of_godmother',
    'Хрещеник або хрещениця хрещеної матері',
    'Хрещена мати',
    'Хрещеник або хрещениця',
    'church',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'godmother',
      'targetEndpoint', 'godchild',
      'genericFallbackCode', 'godparent'
    )
  ),
  (
    'witness_for_bride',
    'church',
    'directed',
    'Свідок по нареченій',
    'bride_witnessed_by',
    'Особа, на шлюбі якої свідчили зі сторони нареченої',
    'Свідок по нареченій',
    'Учасник шлюбу',
    'witness',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'witness_for_bride',
      'targetEndpoint', 'marriage_participant',
      'weddingSide', 'bride',
      'genericFallbackCode', 'witness'
    )
  ),
  (
    'witness_for_groom',
    'church',
    'directed',
    'Свідок по нареченому',
    'groom_witnessed_by',
    'Особа, на шлюбі якої свідчили зі сторони нареченого',
    'Свідок по нареченому',
    'Учасник шлюбу',
    'witness',
    'church',
    true,
    jsonb_build_object(
      'specificPersonRole', true,
      'sourceEndpoint', 'witness_for_groom',
      'targetEndpoint', 'marriage_participant',
      'weddingSide', 'groom',
      'genericFallbackCode', 'witness'
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

-- The generic rows remain selectable and continue to render all existing
-- relations. Their metadata only tells newer clients which precise choices to
-- offer when the historical source supplies enough information.
update public.context_relation_types relation_type
set metadata = relation_type.metadata || desired.metadata_patch
from (values
  (
    'godparent'::text,
    jsonb_build_object(
      'isGenericPersonRole', true,
      'legacyAmbiguous', true,
      'allowNewManualAssertions', false,
      'specificReplacementCodes', jsonb_build_array('godfather', 'godmother')
    )
  ),
  (
    'witness'::text,
    jsonb_build_object(
      'isGenericPersonRole', true,
      'legacyAmbiguous', true,
      'allowNewManualAssertions', false,
      'specificReplacementCodes', jsonb_build_array('witness_for_bride', 'witness_for_groom')
    )
  )
) as desired(code, metadata_patch)
where relation_type.project_id is null
  and relation_type.code = desired.code
  and relation_type.metadata is distinct from relation_type.metadata || desired.metadata_patch;

-- A legacy-only generic type remains readable and editable in place, but it
-- must not be selected for a new manual assertion (or when changing an
-- existing manual assertion to another type). Synchronizers keep working
-- because legacy_import/generated assertions are explicitly exempt.
create or replace function security_private.enforce_context_relation_manual_type_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  allow_new_manual_assertions boolean;
begin
  if tg_op = 'UPDATE'
     and old.assertion_kind in ('legacy_import', 'generated')
     and new.assertion_kind is distinct from old.assertion_kind then
    raise exception 'CONTEXT_RELATION_ASSERTION_KIND_IMMUTABLE'
      using errcode = '22023';
  end if;

  if new.assertion_kind not in ('manual', 'research_hypothesis') then
    return new;
  end if;

  -- Existing generic assertions may still receive notes, evidence status,
  -- privacy, dates and other corrections without being silently retyped.
  if tg_op = 'UPDATE'
     and new.relation_type_id is not distinct from old.relation_type_id then
    return new;
  end if;

  select case lower(coalesce(
    relation_type.metadata ->> 'allowNewManualAssertions',
    ''
  ))
    when 'false' then false
    else true
  end
  into allow_new_manual_assertions
  from public.context_relation_types relation_type
  where relation_type.id = new.relation_type_id;

  -- The existing _10_prepare trigger reports a missing relation type. Keep
  -- this policy trigger neutral if no catalogue row exists.
  if not found then
    return new;
  end if;

  if not allow_new_manual_assertions then
    raise exception 'CONTEXT_RELATION_TYPE_LEGACY_ONLY'
      using errcode = '22023';
  end if;

  return new;
end;
$function$;

drop trigger if exists person_context_relations_15_manual_type_policy
  on public.person_context_relations;
create trigger person_context_relations_15_manual_type_policy
before insert or update on public.person_context_relations
for each row execute function security_private.enforce_context_relation_manual_type_v1();

revoke all on function security_private.enforce_context_relation_manual_type_v1()
  from public, anon, authenticated, service_role;

-- Preserve ambiguous legacy wording as a generic relationship. Only wording
-- that itself identifies the role is mapped to a precise type. This affects
-- future compatibility writes; existing person_context_relations rows are not
-- rewritten or deleted by this migration.
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

comment on function security_private.legacy_person_context_type_code_v1(text) is
  'Maps legacy Ukrainian relation wording to a context type; exact godparent and wedding-side witness roles remain directed and generic wording stays generic.';

-- The compatibility projector in migration 009 knew only the original short
-- wording. Extend its endpoint rule for the exact role phrases without
-- invoking a backfill here: existing projected rows remain byte-for-byte
-- untouched until their legacy source is explicitly changed.
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

analyze public.context_relation_types;

commit;
