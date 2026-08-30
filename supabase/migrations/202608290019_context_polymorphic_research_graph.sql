begin;

-- Forward-only expansion of the contextual graph.  The classic family graph
-- remains untouched: this migration neither adds a tree_id nor updates
-- family_trees.graph_version.  person_context_relations stays the compatible
-- Person-to-Person write model and is projected into the generic table below.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

create table if not exists public.context_relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_type_id uuid not null references public.context_relation_types(id) on delete restrict,
  source_entity_type text not null,
  source_entity_id uuid not null,
  target_entity_type text not null,
  target_entity_id uuid not null,
  source_role_label text not null default '',
  target_role_label text not null default '',
  valid_from date,
  valid_to date,
  period_text text not null default '',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven','likely','disputed','disproven','unknown')),
  confidence integer not null default 0 check (confidence between 0 and 100),
  privacy_status text not null default 'project'
    check (privacy_status in ('private','project','public','confidential')),
  assertion_kind text not null default 'manual'
    check (assertion_kind in ('manual','legacy_import','generated','research_hypothesis')),
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  -- A one-to-one compatibility projection.  Keeping the same public UUID lets
  -- old and new clients refer to a Person-to-Person assertion consistently.
  person_context_relation_id uuid unique
    references public.person_context_relations(id) on delete cascade,
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(user_id) on delete set null,
  constraint context_relations_source_type_check check (
    source_entity_type in (
      'person','family','place','event','document','finding',
      'source','repository','hypothesis'
    )
  ),
  constraint context_relations_target_type_check check (
    target_entity_type in (
      'person','family','place','event','document','finding',
      'source','repository','hypothesis'
    )
  ),
  constraint context_relations_distinct_endpoints_check check (
    source_entity_type <> target_entity_type or source_entity_id <> target_entity_id
  ),
  constraint context_relations_valid_period_check check (
    valid_from is null or valid_to is null or valid_from <= valid_to
  ),
  constraint context_relations_metadata_object_check check (jsonb_typeof(metadata) = 'object'),
  constraint context_relations_person_projection_check check (
    source_entity_type <> 'person'
    or target_entity_type <> 'person'
    or person_context_relation_id is not null
  )
);

comment on table public.context_relations is
  'Project-scoped polymorphic contextual assertions. Family-tree genealogy is deliberately excluded.';
comment on column public.context_relations.person_context_relation_id is
  'Compatibility projection for the existing Person-to-Person context model; generic RPC writes through v1.';

create index if not exists context_relations_project_updated_idx
  on public.context_relations (project_id, updated_at desc, id);
create index if not exists context_relations_source_endpoint_idx
  on public.context_relations (
    project_id, source_entity_type, source_entity_id, deleted_at, updated_at desc
  );
create index if not exists context_relations_target_endpoint_idx
  on public.context_relations (
    project_id, target_entity_type, target_entity_id, deleted_at, updated_at desc
  );
create index if not exists context_relations_type_idx
  on public.context_relations (project_id, relation_type_id, deleted_at);
create index if not exists context_relations_research_idx
  on public.context_relations (project_id, assertion_kind, evidence_status, confidence desc)
  where deleted_at is null;

-- Generic evidence is separate from the v1 evidence table so the proven v1
-- API and its non-null Person relation FK stay binary-compatible.
create table if not exists public.context_relation_evidence_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_id uuid not null references public.context_relations(id) on delete cascade,
  evidence_entity_type text,
  evidence_entity_id uuid,
  citation_id uuid,
  document_fragment_id uuid,
  source_locator text not null default '',
  excerpt text not null default '',
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(user_id) on delete set null,
  constraint context_relation_evidence_links_type_check check (
    evidence_entity_type is null or evidence_entity_type in (
      'person','family','place','event','document','finding',
      'source','repository','hypothesis'
    )
  ),
  constraint context_relation_evidence_links_pair_check check (
    (evidence_entity_type is null) = (evidence_entity_id is null)
  ),
  constraint context_relation_evidence_links_content_check check (
    evidence_entity_id is not null
    or citation_id is not null
    or document_fragment_id is not null
    or btrim(source_locator) <> ''
    or btrim(excerpt) <> ''
    or btrim(notes) <> ''
  ),
  constraint context_relation_evidence_links_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists context_relation_evidence_links_relation_idx
  on public.context_relation_evidence_links (relation_id, deleted_at, created_at, id);
create index if not exists context_relation_evidence_links_entity_idx
  on public.context_relation_evidence_links (
    project_id, evidence_entity_type, evidence_entity_id, deleted_at
  ) where evidence_entity_id is not null;

insert into public.context_relation_types (
  code, category, directionality, label_uk, inverse_code, inverse_label_uk,
  source_role_uk, target_role_uk, icon_token, color_role, is_system
)
values
  ('supports_hypothesis', 'research', 'directed', 'Підтверджує гіпотезу',
    'supported_by', 'Підтверджується', 'Підтвердження', 'Гіпотеза', 'hypothesis', 'research', true),
  ('contradicts_hypothesis', 'research', 'directed', 'Суперечить гіпотезі',
    'contradicted_by', 'Спростовується', 'Спростування', 'Гіпотеза', 'hypothesis', 'research', true),
  ('documented_in', 'documentary', 'directed', 'Задокументовано в',
    'documents_entity', 'Документує', 'Сутність', 'Документ', 'document', 'documentary', true),
  ('located_at', 'documentary', 'directed', 'Пов’язано з місцем',
    'location_of', 'Місце для', 'Сутність', 'Місце', 'place', 'documentary', true),
  ('held_by_repository', 'documentary', 'directed', 'Зберігається в установі',
    'holds_material', 'Зберігає матеріал', 'Матеріал', 'Установа', 'archive', 'documentary', true),
  ('derived_from_source', 'documentary', 'directed', 'Походить із джерела',
    'source_for', 'Джерело для', 'Твердження', 'Джерело', 'source', 'documentary', true)
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
  is_active = true;

create or replace function security_private.context_entity_exists_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  case lower(coalesce(p_entity_type, ''))
    when 'person' then
      return exists (select 1 from public.persons row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'family' then
      return exists (select 1 from public.family_groups row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'place' then
      return exists (
        select 1 from public.places row
        where row.id = p_entity_id
          and (row.project_id = p_project_id or (row.project_id is null and row.is_public and row.status = 'active'))
      );
    when 'event' then
      return exists (select 1 from public.person_timeline_events row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'document' then
      return exists (select 1 from public.documents row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'finding' then
      return exists (select 1 from public.findings row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'source' then
      return exists (select 1 from public.document_sources row where row.id = p_entity_id and row.project_id = p_project_id);
    when 'repository' then
      return exists (
        select 1 from public.archive_resources row
        where row.id = p_entity_id
          and (row.project_id = p_project_id or (row.project_id is null and row.is_public and row.status = 'active'))
      );
    when 'hypothesis' then
      return exists (select 1 from public.hypotheses row where row.id = p_entity_id and row.project_id = p_project_id);
    else
      return false;
  end case;
end;
$function$;

create or replace function security_private.context_entity_is_masked_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select lower(coalesce(p_entity_type, '')) = 'person'
    and not coalesce(p_can_edit, false)
    and exists (
      select 1 from public.persons person
      where person.id = p_entity_id
        and person.project_id = p_project_id
        and person.is_living
        and person.privacy_status in ('private','confidential')
    );
$function$;

create or replace function security_private.context_entity_label_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare result text;
begin
  if security_private.context_entity_is_masked_v2(
    p_project_id, p_entity_type, p_entity_id, p_can_edit
  ) then return 'Приватна особа'; end if;
  case lower(p_entity_type)
    when 'person' then
      select coalesce(nullif(person.full_name,''), nullif(btrim(concat_ws(' ', person.surname, person.given_name, person.patronymic)),''), 'Особа')
      into result from public.persons person where person.id = p_entity_id and person.project_id = p_project_id;
    when 'family' then
      select coalesce(nullif(group_row.display_label,''), 'Родина') into result
      from public.family_groups group_row where group_row.id = p_entity_id and group_row.project_id = p_project_id;
    when 'place' then
      select place.canonical_name into result from public.places place where place.id = p_entity_id;
    when 'event' then
      select coalesce(nullif(event.title,''), nullif(event.event_type,''), 'Подія') into result
      from public.person_timeline_events event where event.id = p_entity_id and event.project_id = p_project_id;
    when 'document' then
      select document.title into result from public.documents document where document.id = p_entity_id and document.project_id = p_project_id;
    when 'finding' then
      select left(coalesce(nullif(finding.summary,''), nullif(finding.description,''), nullif(finding.finding_type,''), 'Знахідка'), 240)
      into result from public.findings finding where finding.id = p_entity_id and finding.project_id = p_project_id;
    when 'source' then
      select left(coalesce(nullif(source.display_name,''), nullif(source.provider_file_title,''), nullif(source.source_page_url,''), source.original_url, 'Джерело'), 240)
      into result from public.document_sources source where source.id = p_entity_id and source.project_id = p_project_id;
    when 'repository' then
      select resource.title into result from public.archive_resources resource where resource.id = p_entity_id;
    when 'hypothesis' then
      select hypothesis.title into result from public.hypotheses hypothesis where hypothesis.id = p_entity_id and hypothesis.project_id = p_project_id;
  end case;
  return coalesce(nullif(result,''), initcap(p_entity_type));
end;
$function$;

create or replace function security_private.context_entity_secondary_label_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare result text;
begin
  if security_private.context_entity_is_masked_v2(
    p_project_id, p_entity_type, p_entity_id, p_can_edit
  ) then return ''; end if;
  case lower(p_entity_type)
    when 'person' then
      select nullif(btrim(concat_ws(' – ', nullif(person.birth_date,''), nullif(person.death_date,''))), '') into result
      from public.persons person where person.id = p_entity_id and person.project_id = p_project_id;
    when 'family' then
      select group_row.group_type into result from public.family_groups group_row where group_row.id = p_entity_id and group_row.project_id = p_project_id;
    when 'place' then
      select nullif(place.modern_name,'') into result from public.places place where place.id = p_entity_id;
    when 'event' then
      select coalesce(nullif(event.date_text,''), nullif(event.event_date,''), nullif(event.place_name,'')) into result
      from public.person_timeline_events event where event.id = p_entity_id and event.project_id = p_project_id;
    when 'document' then
      select nullif(btrim(concat_ws('–', nullif(document.year_from,''), nullif(document.year_to,''))), '') into result
      from public.documents document where document.id = p_entity_id and document.project_id = p_project_id;
    when 'finding' then
      select coalesce(nullif(finding.event_date,''), nullif(finding.place,'')) into result
      from public.findings finding where finding.id = p_entity_id and finding.project_id = p_project_id;
    when 'source' then
      select source.provider into result from public.document_sources source where source.id = p_entity_id and source.project_id = p_project_id;
    when 'repository' then
      select coalesce(nullif(resource.archive_name,''), resource.resource_type) into result
      from public.archive_resources resource where resource.id = p_entity_id;
    when 'hypothesis' then
      select nullif(hypothesis.status,'') into result from public.hypotheses hypothesis where hypothesis.id = p_entity_id and hypothesis.project_id = p_project_id;
  end case;
  return coalesce(result, '');
end;
$function$;

create or replace function security_private.context_entity_metadata_v2(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_can_edit boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare result jsonb := '{}'::jsonb;
begin
  if security_private.context_entity_is_masked_v2(
    p_project_id, p_entity_type, p_entity_id, p_can_edit
  ) then return jsonb_build_object('isLiving', true, 'privacyStatus', 'private'); end if;
  case lower(p_entity_type)
    when 'person' then
      select jsonb_strip_nulls(jsonb_build_object(
        'isLiving', person.is_living, 'privacyStatus', person.privacy_status,
        'gender', nullif(person.gender,''), 'birthDate', nullif(person.birth_date,''),
        'deathDate', nullif(person.death_date,'')
      )) into result
      from public.persons person where person.id = p_entity_id and person.project_id = p_project_id;
    when 'family' then
      select jsonb_build_object('groupType', group_row.group_type)
      into result from public.family_groups group_row where group_row.id = p_entity_id and group_row.project_id = p_project_id;
    when 'place' then
      select jsonb_strip_nulls(jsonb_build_object(
        'modernName', nullif(place.modern_name,''), 'latitude', place.latitude,
        'longitude', place.longitude, 'verificationStatus', place.verification_status
      )) into result from public.places place where place.id = p_entity_id;
    when 'event' then
      select jsonb_strip_nulls(jsonb_build_object(
        'eventType', event.event_type, 'dateText', nullif(event.date_text,''),
        'eventDate', nullif(event.event_date,''), 'placeName', nullif(event.place_name,'')
      )) into result from public.person_timeline_events event where event.id = p_entity_id and event.project_id = p_project_id;
    when 'document' then
      select jsonb_strip_nulls(jsonb_build_object(
        'documentType', nullif(document.document_type,''), 'yearFrom', nullif(document.year_from,''),
        'yearTo', nullif(document.year_to,''), 'place', nullif(document.place,'')
      )) into result from public.documents document where document.id = p_entity_id and document.project_id = p_project_id;
    when 'finding' then
      select jsonb_strip_nulls(jsonb_build_object(
        'findingType', nullif(finding.finding_type,''), 'eventDate', nullif(finding.event_date,''),
        'place', nullif(finding.place,''), 'reliability', nullif(finding.reliability,'')
      )) into result from public.findings finding where finding.id = p_entity_id and finding.project_id = p_project_id;
    when 'source' then
      select jsonb_strip_nulls(jsonb_build_object(
        'provider', source.provider, 'status', source.status, 'documentId', source.document_id
      )) into result from public.document_sources source where source.id = p_entity_id and source.project_id = p_project_id;
    when 'repository' then
      select jsonb_strip_nulls(jsonb_build_object(
        'resourceType', resource.resource_type, 'archiveName', nullif(resource.archive_name,''),
        'isPublic', resource.is_public
      )) into result from public.archive_resources resource where resource.id = p_entity_id;
    when 'hypothesis' then
      select jsonb_strip_nulls(jsonb_build_object(
        'status', nullif(hypothesis.status,''), 'probability', nullif(hypothesis.probability,'')
      )) into result from public.hypotheses hypothesis where hypothesis.id = p_entity_id and hypothesis.project_id = p_project_id;
  end case;
  return coalesce(result, '{}'::jsonb);
end;
$function$;

create or replace function security_private.prepare_context_relation_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  type_row public.context_relation_types%rowtype;
  projection_row public.person_context_relations%rowtype;
  swap_type text;
  swap_id uuid;
  swap_role text;
begin
  new.source_entity_type := lower(btrim(new.source_entity_type));
  new.target_entity_type := lower(btrim(new.target_entity_type));
  new.source_role_label := btrim(coalesce(new.source_role_label,''));
  new.target_role_label := btrim(coalesce(new.target_role_label,''));
  new.period_text := btrim(coalesce(new.period_text,''));
  new.notes := btrim(coalesce(new.notes,''));

  select relation_type.* into type_row
  from public.context_relation_types relation_type
  where relation_type.id = new.relation_type_id;
  if not found then
    raise exception 'CONTEXT_RELATION_TYPE_NOT_FOUND' using errcode = '23503';
  end if;
  if not type_row.is_active and (tg_op = 'INSERT' or new.relation_type_id is distinct from old.relation_type_id) then
    raise exception 'CONTEXT_RELATION_TYPE_INACTIVE' using errcode = '22023';
  end if;
  if type_row.project_id is not null and type_row.project_id <> new.project_id then
    raise exception 'CONTEXT_RELATION_TYPE_PROJECT_MISMATCH' using errcode = '22023';
  end if;

  if tg_op = 'INSERT' or new.deleted_at is null or old.deleted_at is not null then
    if not security_private.context_entity_exists_v2(new.project_id, new.source_entity_type, new.source_entity_id) then
      raise exception 'CONTEXT_SOURCE_ENTITY_NOT_FOUND_IN_PROJECT' using errcode = '23503';
    end if;
    if not security_private.context_entity_exists_v2(new.project_id, new.target_entity_type, new.target_entity_id) then
      raise exception 'CONTEXT_TARGET_ENTITY_NOT_FOUND_IN_PROJECT' using errcode = '23503';
    end if;
  end if;

  if type_row.directionality = 'symmetric'
     and (new.source_entity_type, new.source_entity_id) > (new.target_entity_type, new.target_entity_id) then
    swap_type := new.source_entity_type;
    new.source_entity_type := new.target_entity_type;
    new.target_entity_type := swap_type;
    swap_id := new.source_entity_id;
    new.source_entity_id := new.target_entity_id;
    new.target_entity_id := swap_id;
    swap_role := new.source_role_label;
    new.source_role_label := new.target_role_label;
    new.target_role_label := swap_role;
  end if;

  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      raise exception 'CONTEXT_RELATION_PROJECT_IMMUTABLE' using errcode = '22023';
    end if;
    if new.person_context_relation_id is distinct from old.person_context_relation_id then
      raise exception 'CONTEXT_PERSON_PROJECTION_IMMUTABLE' using errcode = '22023';
    end if;
    new.created_by := old.created_by;
  elsif coalesce(auth.role(),'') <> 'service_role' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if new.person_context_relation_id is not null then
    if coalesce(current_setting('app.context_relation_projection_sync', true),'off') <> 'on' then
      raise exception 'CONTEXT_PERSON_PAIR_WRITE_THROUGH_REQUIRED' using errcode = '55000';
    end if;
    select relation.* into projection_row
    from public.person_context_relations relation
    where relation.id = new.person_context_relation_id;
    if not found
       or projection_row.project_id <> new.project_id
       or projection_row.relation_type_id <> new.relation_type_id
       or projection_row.source_person_id <> new.source_entity_id
       or projection_row.target_person_id <> new.target_entity_id then
      raise exception 'CONTEXT_PERSON_PROJECTION_MISMATCH' using errcode = '23514';
    end if;
  elsif new.source_entity_type = 'person' and new.target_entity_type = 'person' then
    raise exception 'CONTEXT_PERSON_PAIR_WRITE_THROUGH_REQUIRED' using errcode = '55000';
  end if;

  if coalesce(auth.role(),'') <> 'service_role' then new.updated_by := auth.uid(); end if;
  if new.deleted_at is null then
    new.deleted_by := null;
  elsif new.deleted_by is null then
    new.deleted_by := coalesce(auth.uid(), new.updated_by, new.created_by);
  end if;
  return new;
end;
$function$;

create or replace function security_private.prepare_context_relation_evidence_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare parent_project_id uuid;
begin
  select relation.project_id into parent_project_id
  from public.context_relations relation where relation.id = new.relation_id;
  if not found then raise exception 'CONTEXT_RELATION_NOT_FOUND' using errcode = '23503'; end if;
  new.project_id := parent_project_id;
  if new.evidence_entity_id is not null
     and (tg_op = 'INSERT' or new.deleted_at is null or old.deleted_at is not null)
     and not security_private.context_entity_exists_v2(
       parent_project_id, lower(btrim(new.evidence_entity_type)), new.evidence_entity_id
     ) then
      raise exception 'CONTEXT_EVIDENCE_ENTITY_NOT_FOUND_IN_PROJECT' using errcode = '23503';
  end if;
  if new.evidence_entity_type is not null then new.evidence_entity_type := lower(btrim(new.evidence_entity_type)); end if;
  if tg_op = 'UPDATE' then
    if new.relation_id <> old.relation_id then
      raise exception 'CONTEXT_EVIDENCE_RELATION_IMMUTABLE' using errcode = '22023';
    end if;
    new.created_by := old.created_by;
  elsif coalesce(auth.role(),'') <> 'service_role' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;
  if coalesce(auth.role(),'') <> 'service_role' then new.updated_by := auth.uid(); end if;
  if new.deleted_at is null then new.deleted_by := null;
  elsif new.deleted_by is null then new.deleted_by := coalesce(auth.uid(), new.updated_by, new.created_by); end if;
  return new;
end;
$function$;

create or replace function security_private.sync_context_relation_from_person_v2(
  p_person_context_relation_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare source_row public.person_context_relations%rowtype;
declare previous_sync text := current_setting('app.context_relation_projection_sync', true);
declare previous_backfill text := current_setting('app.context_graph_backfill', true);
begin
  select relation.* into source_row
  from public.person_context_relations relation
  where relation.id = p_person_context_relation_id;
  if not found then return; end if;
  perform set_config('app.context_relation_projection_sync', 'on', true);
  perform set_config('app.context_graph_backfill', 'on', true);
  insert into public.context_relations (
    id, project_id, relation_type_id,
    source_entity_type, source_entity_id, target_entity_type, target_entity_id,
    source_role_label, target_role_label, valid_from, valid_to, period_text,
    evidence_status, confidence, privacy_status, assertion_kind, notes, metadata,
    person_context_relation_id, lock_version, created_by, created_at,
    updated_by, updated_at, deleted_at, deleted_by
  ) values (
    source_row.id, source_row.project_id, source_row.relation_type_id,
    'person', source_row.source_person_id, 'person', source_row.target_person_id,
    source_row.source_role_label, source_row.target_role_label,
    source_row.valid_from, source_row.valid_to, source_row.period_text,
    source_row.evidence_status, source_row.confidence, source_row.privacy_status,
    source_row.assertion_kind, source_row.notes,
    source_row.metadata || jsonb_build_object('compatibilityProjection','person_context_relations'),
    source_row.id, source_row.lock_version, source_row.created_by, source_row.created_at,
    source_row.updated_by, source_row.updated_at, source_row.deleted_at, source_row.deleted_by
  )
  on conflict (person_context_relation_id) do update
  set relation_type_id = excluded.relation_type_id,
      source_entity_type = excluded.source_entity_type,
      source_entity_id = excluded.source_entity_id,
      target_entity_type = excluded.target_entity_type,
      target_entity_id = excluded.target_entity_id,
      source_role_label = excluded.source_role_label,
      target_role_label = excluded.target_role_label,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      period_text = excluded.period_text,
      evidence_status = excluded.evidence_status,
      confidence = excluded.confidence,
      privacy_status = excluded.privacy_status,
      assertion_kind = excluded.assertion_kind,
      notes = excluded.notes,
      metadata = excluded.metadata,
      lock_version = excluded.lock_version,
      created_by = excluded.created_by,
      created_at = excluded.created_at,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at,
      deleted_by = excluded.deleted_by;
  perform set_config('app.context_relation_projection_sync', coalesce(previous_sync, 'off'), true);
  perform set_config('app.context_graph_backfill', coalesce(previous_backfill, 'off'), true);
end;
$function$;

create or replace function security_private.person_context_relation_projection_trigger_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  perform security_private.sync_context_relation_from_person_v2(new.id);
  return null;
end;
$function$;

drop trigger if exists context_relations_10_prepare on public.context_relations;
create trigger context_relations_10_prepare
before insert or update on public.context_relations
for each row execute function security_private.prepare_context_relation_v2();

drop trigger if exists context_relations_20_touch on public.context_relations;
create trigger context_relations_20_touch
before update on public.context_relations
for each row
when (coalesce(current_setting('app.context_relation_projection_sync', true),'off') <> 'on')
execute function security_private.touch_context_graph_row_v1();

drop trigger if exists context_relation_evidence_links_10_prepare on public.context_relation_evidence_links;
create trigger context_relation_evidence_links_10_prepare
before insert or update on public.context_relation_evidence_links
for each row execute function security_private.prepare_context_relation_evidence_v2();

drop trigger if exists context_relation_evidence_links_20_touch on public.context_relation_evidence_links;
create trigger context_relation_evidence_links_20_touch
before update on public.context_relation_evidence_links
for each row execute function security_private.touch_context_graph_row_v1();

-- Backfill first, before audit/revision triggers are attached.  Historic
-- assertions remain available through v1 and gain the same UUID in v2.
select set_config('app.context_graph_backfill', 'on', true);
do $context_projection_backfill$
declare relation_id uuid;
begin
  for relation_id in select id from public.person_context_relations order by project_id, id loop
    perform security_private.sync_context_relation_from_person_v2(relation_id);
  end loop;
end;
$context_projection_backfill$;
select set_config('app.context_graph_backfill', 'off', true);

drop trigger if exists person_context_relations_85_generic_projection on public.person_context_relations;
create trigger person_context_relations_85_generic_projection
after insert or update on public.person_context_relations
for each row execute function security_private.person_context_relation_projection_trigger_v2();

create or replace function security_private.context_relation_evidence_count_v2(
  p_relation public.context_relations
)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select (
    (select count(*) from public.context_relation_evidence_links evidence
     where evidence.relation_id = p_relation.id and evidence.deleted_at is null)
    +
    (case when p_relation.person_context_relation_id is null then 0 else
      (select count(*) from public.context_relation_evidence evidence
       where evidence.relation_id = p_relation.person_context_relation_id
         and evidence.deleted_at is null)
     end)
  )::integer;
$function$;

create or replace function security_private.context_relation_json_v2(
  p_relation public.context_relations
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object(
    'id', p_relation.id,
    'projectId', p_relation.project_id,
    'relationTypeId', p_relation.relation_type_id,
    'relationTypeCode', relation_type.code,
    'relationTypeLabel', relation_type.label_uk,
    'relationCategory', relation_type.category,
    'directionality', relation_type.directionality,
    'sourceEntityType', p_relation.source_entity_type,
    'sourceEntityId', p_relation.source_entity_id,
    'targetEntityType', p_relation.target_entity_type,
    'targetEntityId', p_relation.target_entity_id,
    'sourceRoleLabel', p_relation.source_role_label,
    'targetRoleLabel', p_relation.target_role_label,
    'validFrom', p_relation.valid_from,
    'validTo', p_relation.valid_to,
    'periodText', p_relation.period_text,
    'evidenceStatus', p_relation.evidence_status,
    'confidence', p_relation.confidence,
    'privacyStatus', p_relation.privacy_status,
    'assertionKind', p_relation.assertion_kind,
    'notes', p_relation.notes,
    'metadata', p_relation.metadata,
    'personContextRelationId', p_relation.person_context_relation_id,
    'lockVersion', p_relation.lock_version,
    'createdAt', p_relation.created_at,
    'updatedAt', p_relation.updated_at,
    'deletedAt', p_relation.deleted_at,
    'evidenceCount', security_private.context_relation_evidence_count_v2(p_relation)
  )
  from public.context_relation_types relation_type
  where relation_type.id = p_relation.relation_type_id;
$function$;

create or replace function security_private.context_relation_evidence_json_v2(
  p_evidence public.context_relation_evidence_links
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_evidence.id, 'projectId', p_evidence.project_id,
    'relationId', p_evidence.relation_id,
    'evidenceEntityType', p_evidence.evidence_entity_type,
    'evidenceEntityId', p_evidence.evidence_entity_id,
    'citationId', p_evidence.citation_id,
    'documentFragmentId', p_evidence.document_fragment_id,
    'sourceLocator', p_evidence.source_locator,
    'excerpt', p_evidence.excerpt,
    'notes', p_evidence.notes,
    'metadata', p_evidence.metadata,
    'lockVersion', p_evidence.lock_version,
    'createdAt', p_evidence.created_at,
    'updatedAt', p_evidence.updated_at,
    'deletedAt', p_evidence.deleted_at
  );
$function$;

create or replace function security_private.save_context_relation_v2(
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
  source_type text;
  target_type text;
  source_id uuid;
  destination_id uuid;
  type_id uuid;
  requested_assertion_kind text;
  saved public.context_relations%rowtype;
  v1_payload jsonb;
  v1_result jsonb;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 200000 then
    raise exception 'CONTEXT_RELATION_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  target_id := nullif(p_payload ->> 'id','')::uuid;
  source_type := lower(btrim(coalesce(p_payload ->> 'sourceEntityType','')));
  target_type := lower(btrim(coalesce(p_payload ->> 'targetEntityType','')));
  source_id := nullif(p_payload ->> 'sourceEntityId','')::uuid;
  destination_id := nullif(p_payload ->> 'targetEntityId','')::uuid;
  if source_type = '' or target_type = '' or source_id is null or destination_id is null then
    raise exception 'CONTEXT_RELATION_ENDPOINTS_REQUIRED' using errcode = '22023';
  end if;
  type_id := nullif(p_payload ->> 'relationTypeId','')::uuid;
  if type_id is null then
    select relation_type.id into type_id
    from public.context_relation_types relation_type
    where relation_type.is_active
      and lower(relation_type.code) = lower(btrim(p_payload ->> 'relationTypeCode'))
      and (relation_type.project_id = p_project_id or relation_type.project_id is null)
    order by (relation_type.project_id is null), relation_type.id
    limit 1;
  end if;
  if type_id is null then
    raise exception 'CONTEXT_RELATION_TYPE_REQUIRED' using errcode = '22023';
  end if;
  requested_assertion_kind := coalesce(nullif(p_payload ->> 'assertionKind',''),'manual');
  if requested_assertion_kind not in ('manual','research_hypothesis') then
    raise exception 'CONTEXT_RELATION_ASSERTION_KIND_NOT_CLIENT_WRITABLE' using errcode = '22023';
  end if;

  if source_type = 'person' and target_type = 'person' then
    v1_payload := jsonb_build_object(
      'id', target_id,
      'relationTypeId', type_id,
      'sourcePersonId', source_id,
      'targetPersonId', destination_id,
      'sourceRoleLabel', coalesce(p_payload ->> 'sourceRoleLabel',''),
      'targetRoleLabel', coalesce(p_payload ->> 'targetRoleLabel',''),
      'validFrom', p_payload ->> 'validFrom',
      'validTo', p_payload ->> 'validTo',
      'periodText', coalesce(p_payload ->> 'periodText',''),
      'evidenceStatus', coalesce(nullif(p_payload ->> 'evidenceStatus',''),'unknown'),
      'confidence', coalesce((p_payload ->> 'confidence')::integer,0),
      'privacyStatus', coalesce(nullif(p_payload ->> 'privacyStatus',''),'project'),
      'assertionKind', requested_assertion_kind,
      'notes', coalesce(p_payload ->> 'notes',''),
      'metadata', coalesce(p_payload -> 'metadata','{}'::jsonb)
    );
    v1_result := security_private.save_person_context_relation_v1(
      p_project_id, v1_payload, p_expected_lock_version
    );
    select relation.* into saved from public.context_relations relation
    where relation.person_context_relation_id = (v1_result ->> 'id')::uuid;
    if not found then raise exception 'CONTEXT_PERSON_PROJECTION_FAILED' using errcode = 'XX000'; end if;
    return security_private.context_relation_json_v2(saved);
  end if;

  if target_id is null then
    insert into public.context_relations (
      project_id, relation_type_id,
      source_entity_type, source_entity_id, target_entity_type, target_entity_id,
      source_role_label, target_role_label, valid_from, valid_to, period_text,
      evidence_status, confidence, privacy_status, assertion_kind, notes,
      metadata, created_by, updated_by
    ) values (
      p_project_id, type_id, source_type, source_id, target_type, destination_id,
      btrim(coalesce(p_payload ->> 'sourceRoleLabel','')),
      btrim(coalesce(p_payload ->> 'targetRoleLabel','')),
      nullif(p_payload ->> 'validFrom','')::date,
      nullif(p_payload ->> 'validTo','')::date,
      btrim(coalesce(p_payload ->> 'periodText','')),
      coalesce(nullif(p_payload ->> 'evidenceStatus',''),'unknown'),
      coalesce((p_payload ->> 'confidence')::integer,0),
      coalesce(nullif(p_payload ->> 'privacyStatus',''),'project'),
      requested_assertion_kind,
      btrim(coalesce(p_payload ->> 'notes','')),
      coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid(), auth.uid()
    ) returning * into saved;
  else
    if p_expected_lock_version is null then
      raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
    end if;
    update public.context_relations relation
    set relation_type_id = type_id,
        source_entity_type = source_type,
        source_entity_id = source_id,
        target_entity_type = target_type,
        target_entity_id = destination_id,
        source_role_label = btrim(coalesce(p_payload ->> 'sourceRoleLabel','')),
        target_role_label = btrim(coalesce(p_payload ->> 'targetRoleLabel','')),
        valid_from = nullif(p_payload ->> 'validFrom','')::date,
        valid_to = nullif(p_payload ->> 'validTo','')::date,
        period_text = btrim(coalesce(p_payload ->> 'periodText','')),
        evidence_status = coalesce(nullif(p_payload ->> 'evidenceStatus',''),'unknown'),
        confidence = coalesce((p_payload ->> 'confidence')::integer,0),
        privacy_status = coalesce(nullif(p_payload ->> 'privacyStatus',''),'project'),
        assertion_kind = requested_assertion_kind,
        notes = btrim(coalesce(p_payload ->> 'notes','')),
        metadata = coalesce(p_payload -> 'metadata','{}'::jsonb),
        updated_by = auth.uid()
    where relation.id = target_id
      and relation.project_id = p_project_id
      and relation.person_context_relation_id is null
      and relation.deleted_at is null
      and relation.lock_version = p_expected_lock_version
    returning * into saved;
    if not found then raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001'; end if;
  end if;
  return security_private.context_relation_json_v2(saved);
end;
$function$;

create or replace function security_private.archive_context_relation_v2(
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
declare saved public.context_relations%rowtype;
declare projected_id uuid;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_expected_lock_version is null then
    raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;
  select relation.person_context_relation_id into projected_id
  from public.context_relations relation
  where relation.id = p_relation_id and relation.project_id = p_project_id and relation.deleted_at is null;
  if projected_id is not null then
    perform security_private.archive_person_context_relation_v1(
      p_project_id, projected_id, p_expected_lock_version
    );
    select relation.* into saved from public.context_relations relation where relation.id = p_relation_id;
    return security_private.context_relation_json_v2(saved);
  end if;
  update public.context_relations relation
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where relation.id = p_relation_id
    and relation.project_id = p_project_id
    and relation.deleted_at is null
    and relation.lock_version = p_expected_lock_version
  returning * into saved;
  if not found then raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001'; end if;
  update public.context_relation_evidence_links evidence
  set deleted_at = coalesce(evidence.deleted_at,now()),
      deleted_by = coalesce(evidence.deleted_by,auth.uid()), updated_by = auth.uid()
  where evidence.relation_id = saved.id and evidence.deleted_at is null;
  return security_private.context_relation_json_v2(saved);
end;
$function$;

create or replace function security_private.save_context_relation_evidence_v2(
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
declare target_id uuid;
declare target_relation_id uuid;
declare saved public.context_relation_evidence_links%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 200000 then
    raise exception 'CONTEXT_EVIDENCE_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  target_id := nullif(p_payload ->> 'id','')::uuid;
  target_relation_id := nullif(p_payload ->> 'relationId','')::uuid;
  if target_relation_id is null then raise exception 'CONTEXT_RELATION_ID_REQUIRED' using errcode = '22023'; end if;
  if not exists (
    select 1 from public.context_relations relation
    where relation.id = target_relation_id and relation.project_id = p_project_id and relation.deleted_at is null
  ) then raise exception 'CONTEXT_RELATION_NOT_FOUND' using errcode = 'P0002'; end if;
  if target_id is null then
    insert into public.context_relation_evidence_links (
      project_id, relation_id, evidence_entity_type, evidence_entity_id,
      citation_id, document_fragment_id, source_locator, excerpt, notes,
      metadata, created_by, updated_by
    ) values (
      p_project_id, target_relation_id,
      nullif(lower(btrim(p_payload ->> 'evidenceEntityType')),''),
      nullif(p_payload ->> 'evidenceEntityId','')::uuid,
      nullif(p_payload ->> 'citationId','')::uuid,
      nullif(p_payload ->> 'documentFragmentId','')::uuid,
      btrim(coalesce(p_payload ->> 'sourceLocator','')),
      btrim(coalesce(p_payload ->> 'excerpt','')),
      btrim(coalesce(p_payload ->> 'notes','')),
      coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid(), auth.uid()
    ) returning * into saved;
  else
    if p_expected_lock_version is null then raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023'; end if;
    update public.context_relation_evidence_links evidence
    set evidence_entity_type = nullif(lower(btrim(p_payload ->> 'evidenceEntityType')),''),
        evidence_entity_id = nullif(p_payload ->> 'evidenceEntityId','')::uuid,
        citation_id = nullif(p_payload ->> 'citationId','')::uuid,
        document_fragment_id = nullif(p_payload ->> 'documentFragmentId','')::uuid,
        source_locator = btrim(coalesce(p_payload ->> 'sourceLocator','')),
        excerpt = btrim(coalesce(p_payload ->> 'excerpt','')),
        notes = btrim(coalesce(p_payload ->> 'notes','')),
        metadata = coalesce(p_payload -> 'metadata','{}'::jsonb), updated_by = auth.uid()
    where evidence.id = target_id and evidence.project_id = p_project_id
      and evidence.relation_id = target_relation_id and evidence.deleted_at is null
      and evidence.lock_version = p_expected_lock_version
    returning * into saved;
    if not found then raise exception 'CONTEXT_EVIDENCE_STALE_OR_NOT_FOUND' using errcode = '40001'; end if;
  end if;
  return security_private.context_relation_evidence_json_v2(saved);
end;
$function$;

create or replace function security_private.archive_context_relation_evidence_v2(
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
declare saved public.context_relation_evidence_links%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_expected_lock_version is null then raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023'; end if;
  update public.context_relation_evidence_links evidence
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where evidence.id = p_evidence_id and evidence.project_id = p_project_id
    and evidence.deleted_at is null and evidence.lock_version = p_expected_lock_version
  returning * into saved;
  if not found then raise exception 'CONTEXT_EVIDENCE_STALE_OR_NOT_FOUND' using errcode = '40001'; end if;
  return security_private.context_relation_evidence_json_v2(saved);
end;
$function$;

create or replace function security_private.get_person_research_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_assertion_kinds text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_min_confidence integer default null,
  p_has_evidence boolean default null,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
declare can_edit boolean;
declare graph_revision bigint;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if p_center_person_id is null then
    raise exception 'CONTEXT_GRAPH_CENTER_PERSON_REQUIRED' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.persons person
    where person.id = p_center_person_id and person.project_id = p_project_id
  ) then raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002'; end if;
  if p_depth is null or p_depth < 1 or p_depth > 3 then
    raise exception 'CONTEXT_GRAPH_DEPTH_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_max_nodes is null or p_max_nodes < 1 or p_max_nodes > 100 then
    raise exception 'CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_max_edges is null or p_max_edges < 1 or p_max_edges > 250 then
    raise exception 'CONTEXT_GRAPH_MAX_EDGES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_min_confidence is not null and (p_min_confidence < 0 or p_min_confidence > 100) then
    raise exception 'CONTEXT_GRAPH_MIN_CONFIDENCE_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_valid_from is not null and p_valid_to is not null and p_valid_from > p_valid_to then
    raise exception 'CONTEXT_GRAPH_DATE_RANGE_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_entity_types,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in (
      'person','family','place','event','document','finding','source','repository','hypothesis'
    )
  ) then raise exception 'CONTEXT_GRAPH_ENTITY_TYPE_INVALID' using errcode = '22023'; end if;
  if exists (
    select 1 from unnest(coalesce(p_evidence_statuses,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('proven','likely','disputed','disproven','unknown')
  ) then raise exception 'CONTEXT_GRAPH_EVIDENCE_STATUS_INVALID' using errcode = '22023'; end if;
  if exists (
    select 1 from unnest(coalesce(p_assertion_kinds,array[]::text[])) requested(value)
    where requested.value is null or requested.value not in ('manual','legacy_import','generated','research_hypothesis')
  ) then raise exception 'CONTEXT_GRAPH_ASSERTION_KIND_INVALID' using errcode = '22023'; end if;

  can_edit := coalesce(auth.role(),'') = 'service_role' or public.can_edit_project(p_project_id);
  select coalesce(revision.revision,0) into graph_revision
  from (select 1) seed
  left join public.context_graph_revisions revision on revision.project_id = p_project_id;

  with recursive
  relation_base as materialized (
    select
      relation.*,
      relation_type.code as relation_type_code,
      relation_type.label_uk as relation_type_label,
      relation_type.category as relation_category,
      relation_type.directionality,
      evidence.evidence_count
    from public.context_relations relation
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
     and (relation_type.project_id is null or relation_type.project_id = p_project_id)
    cross join lateral (
      select security_private.context_relation_evidence_count_v2(relation) as evidence_count
    ) evidence
    where relation.project_id = p_project_id
      and relation.deleted_at is null
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not (
          (relation.source_entity_type = 'person' and exists (
            select 1 from public.persons person
            where person.project_id = p_project_id and person.id = relation.source_entity_id
              and person.is_living and person.privacy_status in ('private','confidential')
          ))
          or
          (relation.target_entity_type = 'person' and exists (
            select 1 from public.persons person
            where person.project_id = p_project_id and person.id = relation.target_entity_id
              and person.is_living and person.privacy_status in ('private','confidential')
          ))
        )
      )
      and (
        cardinality(coalesce(p_entity_types,array[]::text[])) = 0
        or (relation.source_entity_type = 'person' and relation.source_entity_id = p_center_person_id)
        or relation.source_entity_type = any(p_entity_types)
      )
      and (
        cardinality(coalesce(p_entity_types,array[]::text[])) = 0
        or (relation.target_entity_type = 'person' and relation.target_entity_id = p_center_person_id)
        or relation.target_entity_type = any(p_entity_types)
      )
      and (
        cardinality(coalesce(p_relation_type_ids,array[]::uuid[])) = 0
        or relation.relation_type_id = any(p_relation_type_ids)
      )
      and (
        cardinality(coalesce(p_evidence_statuses,array[]::text[])) = 0
        or relation.evidence_status = any(p_evidence_statuses)
      )
      and (
        cardinality(coalesce(p_assertion_kinds,array[]::text[])) = 0
        or relation.assertion_kind = any(p_assertion_kinds)
      )
      and (p_valid_from is null or relation.valid_to is null or relation.valid_to >= p_valid_from)
      and (p_valid_to is null or relation.valid_from is null or relation.valid_from <= p_valid_to)
      and (p_min_confidence is null or relation.confidence >= p_min_confidence)
      and (p_has_evidence is null or (evidence.evidence_count > 0) = p_has_evidence)
  ), directed_edges as materialized (
    select relation.id as relation_id,
      relation.source_entity_type as from_type, relation.source_entity_id as from_id,
      relation.target_entity_type as to_type, relation.target_entity_id as to_id,
      relation.updated_at
    from relation_base relation
    union all
    select relation.id,
      relation.target_entity_type, relation.target_entity_id,
      relation.source_entity_type, relation.source_entity_id,
      relation.updated_at
    from relation_base relation
  ), walk(entity_type, entity_id, depth) as (
    select 'person'::text, p_center_person_id, 0
    union
    select edge.to_type, edge.to_id, walk.depth + 1
    from walk
    join directed_edges edge
      on edge.from_type = walk.entity_type and edge.from_id = walk.entity_id
    where walk.depth < p_depth
  ), reachable_nodes as (
    select walk.entity_type, walk.entity_id, min(walk.depth) as depth
    from walk group by walk.entity_type, walk.entity_id
  ), node_activity as (
    select reachable.entity_type, reachable.entity_id, reachable.depth,
      max(edge.updated_at) as latest_relation_at
    from reachable_nodes reachable
    left join directed_edges edge
      on edge.from_type = reachable.entity_type and edge.from_id = reachable.entity_id
    group by reachable.entity_type, reachable.entity_id, reachable.depth
  ), ranked_nodes as (
    select activity.*,
      row_number() over (
        order by activity.depth,
          (activity.entity_type = 'person' and activity.entity_id = p_center_person_id) desc,
          activity.latest_relation_at desc nulls last,
          activity.entity_type, activity.entity_id
      ) as node_rank
    from node_activity activity
  ), selected_nodes as materialized (
    select ranked.* from ranked_nodes ranked where ranked.node_rank <= p_max_nodes
  ), candidate_edges as (
    select relation.*,
      greatest(source_node.depth,target_node.depth) as graph_depth
    from relation_base relation
    join selected_nodes source_node
      on source_node.entity_type = relation.source_entity_type
     and source_node.entity_id = relation.source_entity_id
    join selected_nodes target_node
      on target_node.entity_type = relation.target_entity_type
     and target_node.entity_id = relation.target_entity_id
  ), ranked_edges as (
    select candidate.*,
      row_number() over (order by candidate.graph_depth, candidate.updated_at desc, candidate.id) as edge_rank
    from candidate_edges candidate
  ), selected_edges as materialized (
    select ranked.* from ranked_edges ranked where ranked.edge_rank <= p_max_edges
  ), node_rows as (
    select node.node_rank,
      jsonb_build_object(
        'id', node.entity_type || ':' || node.entity_id::text,
        'entityType', node.entity_type,
        'entityId', node.entity_id,
        'label', security_private.context_entity_label_v2(
          p_project_id,node.entity_type,node.entity_id,can_edit
        ),
        'secondaryLabel', security_private.context_entity_secondary_label_v2(
          p_project_id,node.entity_type,node.entity_id,can_edit
        ),
        'isCenter', node.entity_type = 'person' and node.entity_id = p_center_person_id,
        'masked', security_private.context_entity_is_masked_v2(
          p_project_id,node.entity_type,node.entity_id,can_edit
        ),
        'depth', node.depth,
        'metadata', security_private.context_entity_metadata_v2(
          p_project_id,node.entity_type,node.entity_id,can_edit
        )
      ) as payload
    from selected_nodes node
  ), edge_rows as (
    select edge.edge_rank,
      jsonb_build_object(
        'id', edge.id,
        'source', edge.source_entity_type || ':' || edge.source_entity_id::text,
        'target', edge.target_entity_type || ':' || edge.target_entity_id::text,
        'sourceEntityType', edge.source_entity_type,
        'sourceEntityId', edge.source_entity_id,
        'targetEntityType', edge.target_entity_type,
        'targetEntityId', edge.target_entity_id,
        'relationTypeId', edge.relation_type_id,
        'relationTypeCode', edge.relation_type_code,
        'relationTypeLabel', edge.relation_type_label,
        'relationCategory', edge.relation_category,
        'directionality', edge.directionality,
        'sourceRoleLabel', edge.source_role_label,
        'targetRoleLabel', edge.target_role_label,
        'validFrom', edge.valid_from,
        'validTo', edge.valid_to,
        'periodText', edge.period_text,
        'evidenceStatus', edge.evidence_status,
        'confidence', edge.confidence,
        'privacyStatus', edge.privacy_status,
        'assertionKind', edge.assertion_kind,
        'generated', edge.assertion_kind = 'generated',
        'metadata', edge.metadata,
        'lockVersion', edge.lock_version,
        'evidenceCount', edge.evidence_count
      ) as payload
    from selected_edges edge
  )
  select jsonb_build_object(
    'projectId', p_project_id,
    'center', jsonb_build_object('entityType','person','entityId',p_center_person_id),
    'depth', p_depth,
    'revision', graph_revision,
    'nodes', coalesce((select jsonb_agg(node.payload order by node.node_rank) from node_rows node),'[]'::jsonb),
    'edges', coalesce((select jsonb_agg(edge.payload order by edge.edge_rank) from edge_rows edge),'[]'::jsonb),
    'limits', jsonb_build_object('maxNodes',p_max_nodes,'maxEdges',p_max_edges),
    'truncated', jsonb_build_object(
      'nodes',(select count(*) from reachable_nodes) > p_max_nodes,
      'edges',(select count(*) from candidate_edges) > p_max_edges
    ),
    'filters', jsonb_build_object(
      'entityTypes',coalesce(to_jsonb(p_entity_types),'[]'::jsonb),
      'relationTypeIds',coalesce(to_jsonb(p_relation_type_ids),'[]'::jsonb),
      'evidenceStatuses',coalesce(to_jsonb(p_evidence_statuses),'[]'::jsonb),
      'assertionKinds',coalesce(to_jsonb(p_assertion_kinds),'[]'::jsonb),
      'validFrom',p_valid_from,'validTo',p_valid_to,
      'minConfidence',p_min_confidence,'hasEvidence',p_has_evidence
    )
  ) into result;
  return result;
end;
$function$;

create or replace function security_private.cleanup_context_endpoint_v2()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare endpoint_type text := tg_argv[0];
begin
  update public.context_relations relation
  set deleted_at = coalesce(relation.deleted_at,now()),
      deleted_by = coalesce(relation.deleted_by,auth.uid()),
      updated_by = coalesce(auth.uid(),relation.updated_by)
  where relation.deleted_at is null
    and relation.person_context_relation_id is null
    and (
      (relation.source_entity_type = endpoint_type and relation.source_entity_id = old.id)
      or (relation.target_entity_type = endpoint_type and relation.target_entity_id = old.id)
    );
  update public.context_relation_evidence_links evidence
  set deleted_at = coalesce(evidence.deleted_at,now()),
      deleted_by = coalesce(evidence.deleted_by,auth.uid()),
      updated_by = coalesce(auth.uid(),evidence.updated_by)
  where evidence.deleted_at is null
    and evidence.evidence_entity_type = endpoint_type
    and evidence.evidence_entity_id = old.id;
  return old;
end;
$function$;

do $context_endpoint_cleanup_triggers$
declare endpoint record;
begin
  for endpoint in
    select * from (values
      ('persons','person'), ('family_groups','family'), ('places','place'),
      ('person_timeline_events','event'), ('documents','document'),
      ('findings','finding'), ('document_sources','source'),
      ('archive_resources','repository'), ('hypotheses','hypothesis')
    ) endpoints(table_name, entity_type)
  loop
    execute format('drop trigger if exists %I on public.%I',
      endpoint.table_name || '_context_endpoint_cleanup_v2', endpoint.table_name);
    execute format(
      'create trigger %I after delete on public.%I for each row execute function security_private.cleanup_context_endpoint_v2(%L)',
      endpoint.table_name || '_context_endpoint_cleanup_v2', endpoint.table_name, endpoint.entity_type
    );
  end loop;
end;
$context_endpoint_cleanup_triggers$;

do $context_v2_audit_revision_triggers$
declare table_name text;
begin
  foreach table_name in array array['context_relations','context_relation_evidence_links'] loop
    execute format('drop trigger if exists %I on public.%I',table_name || '_90_audit',table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function security_private.audit_context_graph_row_v1()',
      table_name || '_90_audit',table_name
    );
    execute format('drop trigger if exists %I on public.%I',table_name || '_95_revision_insert',table_name);
    execute format(
      'create trigger %I after insert on public.%I referencing new table as new_rows for each statement execute function security_private.bump_context_graph_revision_new_v1()',
      table_name || '_95_revision_insert',table_name
    );
    execute format('drop trigger if exists %I on public.%I',table_name || '_95_revision_update',table_name);
    execute format(
      'create trigger %I after update on public.%I referencing new table as new_rows for each statement execute function security_private.bump_context_graph_revision_new_v1()',
      table_name || '_95_revision_update',table_name
    );
    execute format('drop trigger if exists %I on public.%I',table_name || '_95_revision_delete',table_name);
    execute format(
      'create trigger %I after delete on public.%I referencing old table as old_rows for each statement execute function security_private.bump_context_graph_revision_old_v1()',
      table_name || '_95_revision_delete',table_name
    );
  end loop;
end;
$context_v2_audit_revision_triggers$;

alter table public.context_relations enable row level security;
alter table public.context_relation_evidence_links enable row level security;

drop policy if exists context_relations_select_members on public.context_relations;
create policy context_relations_select_members
on public.context_relations for select to authenticated
using (
  (select public.is_project_member(project_id))
  and (privacy_status <> 'confidential' or (select public.can_edit_project(project_id)))
  and (
    (select public.can_edit_project(project_id))
    or not (
      (source_entity_type = 'person' and exists (
        select 1 from public.persons person
        where person.project_id = context_relations.project_id
          and person.id = context_relations.source_entity_id
          and person.is_living and person.privacy_status in ('private','confidential')
      ))
      or (target_entity_type = 'person' and exists (
        select 1 from public.persons person
        where person.project_id = context_relations.project_id
          and person.id = context_relations.target_entity_id
          and person.is_living and person.privacy_status in ('private','confidential')
      ))
    )
  )
);

drop policy if exists context_relations_insert_editors on public.context_relations;
create policy context_relations_insert_editors on public.context_relations
for insert to authenticated with check ((select public.can_edit_project(project_id)));
drop policy if exists context_relations_update_editors on public.context_relations;
create policy context_relations_update_editors on public.context_relations
for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));
drop policy if exists context_relations_delete_editors on public.context_relations;
create policy context_relations_delete_editors on public.context_relations
for delete to authenticated using ((select public.can_edit_project(project_id)));

drop policy if exists context_relation_evidence_links_select_members on public.context_relation_evidence_links;
create policy context_relation_evidence_links_select_members
on public.context_relation_evidence_links for select to authenticated
using (
  (select public.is_project_member(project_id))
  and exists (
    select 1 from public.context_relations relation
    where relation.id = context_relation_evidence_links.relation_id
      and relation.project_id = context_relation_evidence_links.project_id
      and relation.deleted_at is null
      and (relation.privacy_status <> 'confidential'
        or (select public.can_edit_project(context_relation_evidence_links.project_id)))
  )
);
drop policy if exists context_relation_evidence_links_insert_editors on public.context_relation_evidence_links;
create policy context_relation_evidence_links_insert_editors
on public.context_relation_evidence_links for insert to authenticated
with check ((select public.can_edit_project(project_id)));
drop policy if exists context_relation_evidence_links_update_editors on public.context_relation_evidence_links;
create policy context_relation_evidence_links_update_editors
on public.context_relation_evidence_links for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));
drop policy if exists context_relation_evidence_links_delete_editors on public.context_relation_evidence_links;
create policy context_relation_evidence_links_delete_editors
on public.context_relation_evidence_links for delete to authenticated
using ((select public.can_edit_project(project_id)));

create or replace function public.save_context_relation_v2(
  p_project_id uuid, p_payload jsonb, p_expected_lock_version integer default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.save_context_relation_v2($1,$2,$3);
$wrapper$;

create or replace function public.archive_context_relation_v2(
  p_project_id uuid, p_relation_id uuid, p_expected_lock_version integer
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.archive_context_relation_v2($1,$2,$3);
$wrapper$;

create or replace function public.save_context_relation_evidence_v2(
  p_project_id uuid, p_payload jsonb, p_expected_lock_version integer default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.save_context_relation_evidence_v2($1,$2,$3);
$wrapper$;

create or replace function public.archive_context_relation_evidence_v2(
  p_project_id uuid, p_evidence_id uuid, p_expected_lock_version integer
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.archive_context_relation_evidence_v2($1,$2,$3);
$wrapper$;

create or replace function public.get_person_research_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_relation_type_ids uuid[] default null,
  p_evidence_statuses text[] default null,
  p_assertion_kinds text[] default null,
  p_valid_from date default null,
  p_valid_to date default null,
  p_min_confidence integer default null,
  p_has_evidence boolean default null,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.get_person_research_context_graph_v1(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
  );
$wrapper$;

revoke all on table public.context_relations, public.context_relation_evidence_links
from public, anon, authenticated;
grant all on table public.context_relations, public.context_relation_evidence_links
to service_role;

do $context_v2_function_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure as signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'security_private'
      and procedure.proname = any(array[
        'context_entity_exists_v2','context_entity_is_masked_v2',
        'context_entity_label_v2','context_entity_secondary_label_v2',
        'context_entity_metadata_v2','prepare_context_relation_v2',
        'prepare_context_relation_evidence_v2','sync_context_relation_from_person_v2',
        'person_context_relation_projection_trigger_v2','context_relation_evidence_count_v2',
        'context_relation_json_v2','context_relation_evidence_json_v2',
        'save_context_relation_v2','archive_context_relation_v2',
        'save_context_relation_evidence_v2','archive_context_relation_evidence_v2',
        'get_person_research_context_graph_v1','cleanup_context_endpoint_v2'
      ]::text[])
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',function_record.signature);
  end loop;
end;
$context_v2_function_acl$;

grant execute on function security_private.save_context_relation_v2(uuid,jsonb,integer)
to authenticated, service_role;
grant execute on function security_private.archive_context_relation_v2(uuid,uuid,integer)
to authenticated, service_role;
grant execute on function security_private.save_context_relation_evidence_v2(uuid,jsonb,integer)
to authenticated, service_role;
grant execute on function security_private.archive_context_relation_evidence_v2(uuid,uuid,integer)
to authenticated, service_role;
grant execute on function security_private.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) to authenticated, service_role;

revoke all on function public.save_context_relation_v2(uuid,jsonb,integer)
from public, anon, authenticated, service_role;
revoke all on function public.archive_context_relation_v2(uuid,uuid,integer)
from public, anon, authenticated, service_role;
revoke all on function public.save_context_relation_evidence_v2(uuid,jsonb,integer)
from public, anon, authenticated, service_role;
revoke all on function public.archive_context_relation_evidence_v2(uuid,uuid,integer)
from public, anon, authenticated, service_role;
revoke all on function public.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) from public, anon, authenticated, service_role;

grant execute on function public.save_context_relation_v2(uuid,jsonb,integer)
to authenticated, service_role;
grant execute on function public.archive_context_relation_v2(uuid,uuid,integer)
to authenticated, service_role;
grant execute on function public.save_context_relation_evidence_v2(uuid,jsonb,integer)
to authenticated, service_role;
grant execute on function public.archive_context_relation_evidence_v2(uuid,uuid,integer)
to authenticated, service_role;
grant execute on function public.get_person_research_context_graph_v1(
  uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer
) to authenticated, service_role;

-- Keep durable asynchronous project deletion complete and dependency ordered.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array[
    'context_relation_evidence_links',
    'context_relations',
    'context_relation_evidence',
    'person_context_relations',
    'context_relation_types',
    'context_graph_revisions',
    'legacy_person_relation_graph_edges',
    'ai_hypothesis_reviews',
    'family_tree_research_issues',
    'tree_layout_positions',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_timeline_events',
    'place_merge_preserved_rows',
    'place_merge_operations',
    'document_place_links',
    'place_archive_relations',
    'place_parish_relations',
    'place_relations',
    'place_boundaries',
    'archive_resources',
    'place_change_requests',
    'place_external_identifiers',
    'place_hierarchy_relations',
    'place_names',
    'place_type_assignments',
    'places',
    'person_names',
    'association_relationships',
    'parent_child_relationships',
    'parent_sets',
    'partner_relationships',
    'family_group_members',
    'family_groups',
    'family_tree_persons',
    'gedcom_import_batches',
    'family_tree_user_preferences',
    'family_trees',
    'pdf_access_sessions',
    'finding_document_references',
    'finding_participants',
    'task_persons',
    'task_notifications',
    'archive_request_persons',
    'hypothesis_links',
    'record_links',
    'custom_records',
    'custom_section_fields',
    'attachments',
    'activity_log',
    'year_matrix',
    'tasks',
    'findings',
    'hypotheses',
    'archive_requests',
    'person_relations',
    'document_sources',
    'documents',
    'persons',
    'custom_field_definitions',
    'custom_sections',
    'researches',
    'project_invitations'
  ]::text[];
$function$;

revoke execute on function private.project_deletion_phase_names()
from public, anon, authenticated;

do $context_v2_project_deletion_coverage$
declare uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if coalesce(cardinality(uncovered_tables),0) > 0 then
    raise exception 'PROJECT_DELETION_PHASES_MISSING_TABLES: %',array_to_string(uncovered_tables,', ');
  end if;
end;
$context_v2_project_deletion_coverage$;

notify pgrst, 'reload schema';
analyze public.context_relations;
analyze public.context_relation_evidence_links;

commit;
