begin;

-- The contextual graph is deliberately project-scoped. It must never depend
-- on a family_tree row or participate in family_trees.graph_version updates.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

-- Strengthen the existing structured participant link before the contextual
-- graph starts deriving evidence from it. The old single-column FKs prove that
-- the records exist, but not that Finding, participant and Person share one
-- project. Fail visibly instead of silently accepting historical corruption.
do $participant_scope_preflight$
declare
  bad_finding_count bigint;
  bad_person_count bigint;
  sample_participant_id uuid;
begin
  select count(*)
  into bad_finding_count
  from public.finding_participants participant
  left join public.findings finding on finding.id = participant.finding_id
  where finding.id is null or finding.project_id <> participant.project_id;

  if bad_finding_count > 0 then
    select participant.id into sample_participant_id
    from public.finding_participants participant
    left join public.findings finding on finding.id = participant.finding_id
    where finding.id is null or finding.project_id <> participant.project_id
    order by participant.id
    limit 1;
    raise exception 'FINDING_PARTICIPANT_FINDING_PROJECT_MISMATCH: % row(s), sample participant %',
      bad_finding_count, sample_participant_id
      using errcode = '23514';
  end if;

  select count(*)
  into bad_person_count
  from public.finding_participants participant
  left join public.persons person on person.id = participant.person_id
  where participant.person_id is not null
    and (person.id is null or person.project_id <> participant.project_id);

  if bad_person_count > 0 then
    select participant.id into sample_participant_id
    from public.finding_participants participant
    left join public.persons person on person.id = participant.person_id
    where participant.person_id is not null
      and (person.id is null or person.project_id <> participant.project_id)
    order by participant.id
    limit 1;
    raise exception 'FINDING_PARTICIPANT_PERSON_PROJECT_MISMATCH: % row(s), sample participant %',
      bad_person_count, sample_participant_id
      using errcode = '23514';
  end if;
end;
$participant_scope_preflight$;

do $participant_scope_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_finding_project_fkey'
  ) then
    alter table public.finding_participants
      add constraint finding_participants_finding_project_fkey
      foreign key (finding_id, project_id)
      references public.findings(id, project_id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_person_project_fkey'
  ) then
    alter table public.finding_participants
      add constraint finding_participants_person_project_fkey
      foreign key (person_id, project_id)
      references public.persons(id, project_id)
      on delete set null (person_id)
      not valid;
  end if;
end;
$participant_scope_constraints$;

alter table public.finding_participants
  validate constraint finding_participants_finding_project_fkey;
alter table public.finding_participants
  validate constraint finding_participants_person_project_fkey;

create table if not exists public.context_relation_types (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete cascade,
  code text not null,
  category text not null default 'social'
    check (category in (
      'church', 'household', 'social', 'military', 'documentary',
      'research', 'occupation', 'education', 'other'
    )),
  directionality text not null default 'directed'
    check (directionality in ('directed', 'symmetric')),
  label_uk text not null,
  inverse_code text not null default '',
  inverse_label_uk text not null default '',
  source_role_uk text not null default '',
  target_role_uk text not null default '',
  icon_token text not null default '',
  color_role text not null default 'context',
  is_system boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  check (code = lower(btrim(code))),
  check (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  check (char_length(label_uk) between 1 and 160),
  check (char_length(inverse_code) <= 64),
  check (char_length(inverse_label_uk) <= 160),
  check ((is_system and project_id is null) or (not is_system and project_id is not null))
);

comment on table public.context_relation_types is
  'System and project-defined non-genealogical Person-to-Person relation types. No family-tree type is allowed here.';

create unique index if not exists context_relation_types_system_code_uq
  on public.context_relation_types (lower(code))
  where project_id is null;
create unique index if not exists context_relation_types_project_code_uq
  on public.context_relation_types (project_id, lower(code))
  where project_id is not null;
create index if not exists context_relation_types_project_active_idx
  on public.context_relation_types (project_id, is_active, category, code);

create table if not exists public.person_context_relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_type_id uuid not null references public.context_relation_types(id) on delete restrict,
  source_person_id uuid not null,
  target_person_id uuid not null,
  source_role_label text not null default '',
  target_role_label text not null default '',
  valid_from date,
  valid_to date,
  period_text text not null default '',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 0 check (confidence between 0 and 100),
  privacy_status text not null default 'project'
    check (privacy_status in ('private', 'project', 'public', 'confidential')),
  assertion_kind text not null default 'manual'
    check (assertion_kind in ('manual', 'legacy_import', 'generated', 'research_hypothesis')),
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  legacy_source_table text,
  legacy_source_id uuid,
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(user_id) on delete set null,
  foreign key (source_person_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  foreign key (target_person_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  check (source_person_id <> target_person_id),
  check (valid_from is null or valid_to is null or valid_from <= valid_to),
  check (
    (legacy_source_table is null and legacy_source_id is null)
    or (legacy_source_table in ('association_relationships', 'person_relations') and legacy_source_id is not null)
  )
);

comment on table public.person_context_relations is
  'Project-level social/contextual assertions. This table intentionally has no tree_id and is never read by family graph RPCs.';

create index if not exists person_context_relations_project_updated_idx
  on public.person_context_relations (project_id, updated_at desc, id);
create index if not exists person_context_relations_source_idx
  on public.person_context_relations (project_id, source_person_id, deleted_at, updated_at desc);
create index if not exists person_context_relations_target_idx
  on public.person_context_relations (project_id, target_person_id, deleted_at, updated_at desc);
create index if not exists person_context_relations_type_idx
  on public.person_context_relations (project_id, relation_type_id, deleted_at);
create unique index if not exists person_context_relations_legacy_source_uq
  on public.person_context_relations (legacy_source_table, legacy_source_id)
  where legacy_source_id is not null;

create table if not exists public.context_relation_evidence (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_id uuid not null references public.person_context_relations(id) on delete cascade,
  evidence_kind text not null default 'note'
    check (evidence_kind in (
      'document', 'finding', 'event', 'citation', 'document_fragment',
      'legacy_text', 'note', 'other'
    )),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  source_event_id uuid references public.person_timeline_events(id) on delete set null,
  finding_participant_id uuid references public.finding_participants(id) on delete set null,
  citation_id uuid,
  document_fragment_id uuid,
  source_locator text not null default '',
  excerpt text not null default '',
  notes text not null default '',
  origin_key text,
  metadata jsonb not null default '{}'::jsonb,
  lock_version integer not null default 1 check (lock_version > 0),
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.profiles(user_id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(user_id) on delete set null,
  check (origin_key is null or char_length(origin_key) between 1 and 200),
  check (
    source_document_id is not null
    or source_finding_id is not null
    or source_event_id is not null
    or finding_participant_id is not null
    or citation_id is not null
    or document_fragment_id is not null
    or btrim(source_locator) <> ''
    or btrim(excerpt) <> ''
    or btrim(notes) <> ''
  )
);

comment on table public.context_relation_evidence is
  'Zero-to-many evidence items for a contextual assertion. Citation and fragment UUIDs are forward-compatible until canonical entities exist.';

create index if not exists context_relation_evidence_relation_idx
  on public.context_relation_evidence (relation_id, deleted_at, created_at, id);
create index if not exists context_relation_evidence_project_idx
  on public.context_relation_evidence (project_id, updated_at desc, id);
create index if not exists context_relation_evidence_document_idx
  on public.context_relation_evidence (source_document_id)
  where source_document_id is not null;
create index if not exists context_relation_evidence_finding_idx
  on public.context_relation_evidence (source_finding_id)
  where source_finding_id is not null;
create unique index if not exists context_relation_evidence_origin_uq
  on public.context_relation_evidence (relation_id, origin_key)
  where origin_key is not null;

create table if not exists public.context_graph_revisions (
  project_id uuid primary key references public.projects(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

comment on table public.context_graph_revisions is
  'Independent cache revision for the contextual graph. It never changes family_trees.graph_version.';

create table if not exists security_private.context_graph_audit_log (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  entity_table text not null,
  entity_id uuid,
  actor_id uuid,
  action text not null check (action in ('insert', 'update', 'delete')),
  before_data jsonb,
  after_data jsonb,
  transaction_id bigint not null default pg_catalog.txid_current(),
  created_at timestamptz not null default now()
);

create index if not exists context_graph_audit_project_idx
  on security_private.context_graph_audit_log (project_id, created_at desc, id desc);
create index if not exists context_graph_audit_entity_idx
  on security_private.context_graph_audit_log (entity_table, entity_id, created_at desc, id desc);

revoke all on table security_private.context_graph_audit_log
  from public, anon, authenticated, service_role;

-- Seed only social/contextual concepts. Family roles remain exclusively in
-- parent_child_relationships and partner_relationships.
insert into public.context_relation_types (
  code, category, directionality, label_uk, inverse_code, inverse_label_uk,
  source_role_uk, target_role_uk, icon_token, color_role, is_system
)
values
  ('godparent', 'church', 'directed', 'Хрещений батько або мати', 'godchild', 'Хрещеник або хрещениця', 'Хрещений', 'Хрещеник', 'church', 'church', true),
  ('witness', 'church', 'directed', 'Свідок', 'witnessed_person', 'Особа, для якої свідчили', 'Свідок', 'Учасник події', 'witness', 'church', true),
  ('sponsor', 'church', 'directed', 'Поручитель', 'sponsored_person', 'Особа під поручительством', 'Поручитель', 'Учасник події', 'sponsor', 'church', true),
  ('neighbor', 'social', 'symmetric', 'Сусідство', 'neighbor', 'Сусідство', 'Сусід', 'Сусід', 'home', 'social', true),
  ('household_member', 'household', 'symmetric', 'Члени одного господарства', 'household_member', 'Члени одного господарства', 'Член господарства', 'Член господарства', 'household', 'household', true),
  ('household_head', 'household', 'directed', 'Голова господарства', 'household_dependent', 'Член господарства', 'Голова господарства', 'Член господарства', 'household', 'household', true),
  ('servant', 'household', 'directed', 'Наймит або служник', 'employer', 'Господар або роботодавець', 'Наймит або служник', 'Господар', 'occupation', 'household', true),
  ('caregiver', 'social', 'directed', 'Опікун без батьківства', 'care_recipient', 'Підопічний', 'Опікун', 'Підопічний', 'care', 'social', true),
  ('benefactor', 'social', 'directed', 'Благодійник', 'beneficiary', 'Отримувач допомоги', 'Благодійник', 'Отримувач допомоги', 'benefactor', 'social', true),
  ('namesake', 'social', 'symmetric', 'Тезки', 'namesake', 'Тезки', 'Тезка', 'Тезка', 'name', 'social', true),
  ('clergy', 'church', 'directed', 'Духовна особа при події', 'served_by_clergy', 'Особа, яку обслуговувала духовна особа', 'Духовна особа', 'Учасник події', 'church', 'church', true),
  ('official', 'social', 'directed', 'Посадова особа при події', 'served_by_official', 'Особа, яку обслуговувала посадова особа', 'Посадова особа', 'Учасник події', 'official', 'social', true),
  ('midwife', 'social', 'directed', 'Повитуха', 'assisted_by_midwife', 'Особа, при народженні якої була повитуха', 'Повитуха', 'Новонароджений', 'midwife', 'social', true),
  ('informant', 'documentary', 'directed', 'Особа, яка повідомила', 'reported_person', 'Особа, про яку повідомили', 'Інформатор', 'Особа в записі', 'document', 'documentary', true),
  ('mentioned_in_source', 'documentary', 'symmetric', 'Згадані в одному джерелі', 'mentioned_in_source', 'Згадані в одному джерелі', 'Згадана особа', 'Згадана особа', 'document', 'documentary', true),
  ('dna_match', 'research', 'symmetric', 'Збіг ДНК', 'dna_match', 'Збіг ДНК', 'Збіг ДНК', 'Збіг ДНК', 'dna', 'research', true),
  ('possible_relative', 'research', 'symmetric', 'Можливе споріднення', 'possible_relative', 'Можливе споріднення', 'Можливий родич', 'Можливий родич', 'hypothesis', 'research', true),
  ('guardian_non_parent', 'social', 'directed', 'Опікун без батьківства', 'ward_non_child', 'Підопічний без зв’язку батьківства', 'Опікун', 'Підопічний', 'care', 'social', true),
  ('other', 'other', 'symmetric', 'Інший контекстний зв’язок', 'other', 'Інший контекстний зв’язок', '', '', 'link', 'context', true)
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

create or replace function security_private.prepare_context_relation_type_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  new.code := lower(btrim(new.code));
  new.label_uk := btrim(new.label_uk);
  new.inverse_code := lower(btrim(new.inverse_code));
  new.inverse_label_uk := btrim(new.inverse_label_uk);

  if tg_op = 'UPDATE' then
    if new.project_id is distinct from old.project_id or new.is_system is distinct from old.is_system then
      raise exception 'CONTEXT_RELATION_TYPE_SCOPE_IMMUTABLE' using errcode = '22023';
    end if;
    new.created_by := old.created_by;
  end if;

  if new.is_system then
    if coalesce(auth.role(), '') <> 'service_role'
       and current_user not in ('postgres', 'supabase_admin') then
      raise exception 'SYSTEM_CONTEXT_RELATION_TYPE_IMMUTABLE' using errcode = '42501';
    end if;
  else
    if exists (
      select 1
      from public.context_relation_types system_type
      where system_type.project_id is null
        and lower(system_type.code) = new.code
        and system_type.id <> new.id
    ) then
      raise exception 'CONTEXT_RELATION_TYPE_CODE_RESERVED' using errcode = '23505';
    end if;
    if coalesce(auth.role(), '') <> 'service_role' then
      new.created_by := coalesce(new.created_by, auth.uid());
      new.updated_by := auth.uid();
    end if;
  end if;

  return new;
end;
$function$;

create or replace function security_private.prepare_person_context_relation_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  type_row public.context_relation_types%rowtype;
  swap_person_id uuid;
  swap_role text;
begin
  select relation_type.*
  into type_row
  from public.context_relation_types relation_type
  where relation_type.id = new.relation_type_id;

  if not found then
    raise exception 'CONTEXT_RELATION_TYPE_NOT_FOUND' using errcode = '23503';
  end if;
  if not type_row.is_active then
    if tg_op = 'INSERT' then
      raise exception 'CONTEXT_RELATION_TYPE_INACTIVE' using errcode = '22023';
    elsif new.relation_type_id is distinct from old.relation_type_id then
      raise exception 'CONTEXT_RELATION_TYPE_INACTIVE' using errcode = '22023';
    end if;
  end if;
  if type_row.project_id is not null and type_row.project_id <> new.project_id then
    raise exception 'CONTEXT_RELATION_TYPE_PROJECT_MISMATCH' using errcode = '22023';
  end if;

  if type_row.directionality = 'symmetric' and new.source_person_id > new.target_person_id then
    swap_person_id := new.source_person_id;
    new.source_person_id := new.target_person_id;
    new.target_person_id := swap_person_id;
    swap_role := new.source_role_label;
    new.source_role_label := new.target_role_label;
    new.target_role_label := swap_role;
  end if;

  if tg_op = 'UPDATE' then
    if new.project_id <> old.project_id then
      raise exception 'CONTEXT_RELATION_PROJECT_IMMUTABLE' using errcode = '22023';
    end if;
    if new.legacy_source_table is distinct from old.legacy_source_table
       or new.legacy_source_id is distinct from old.legacy_source_id then
      raise exception 'CONTEXT_RELATION_LEGACY_ORIGIN_IMMUTABLE' using errcode = '22023';
    end if;
    new.created_by := old.created_by;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.updated_by := auth.uid();
  end if;

  if new.deleted_at is null then
    new.deleted_by := null;
  elsif new.deleted_by is null then
    new.deleted_by := coalesce(auth.uid(), new.updated_by, new.created_by);
  end if;

  return new;
end;
$function$;

create or replace function security_private.prepare_context_relation_evidence_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  parent_project_id uuid;
  linked_project_id uuid;
begin
  select relation.project_id
  into parent_project_id
  from public.person_context_relations relation
  where relation.id = new.relation_id;
  if not found then
    raise exception 'CONTEXT_RELATION_NOT_FOUND' using errcode = '23503';
  end if;
  new.project_id := parent_project_id;

  if new.source_document_id is not null then
    select document.project_id into linked_project_id
    from public.documents document where document.id = new.source_document_id;
    if not found or linked_project_id <> parent_project_id then
      raise exception 'CONTEXT_EVIDENCE_DOCUMENT_PROJECT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.source_finding_id is not null then
    select finding.project_id into linked_project_id
    from public.findings finding where finding.id = new.source_finding_id;
    if not found or linked_project_id <> parent_project_id then
      raise exception 'CONTEXT_EVIDENCE_FINDING_PROJECT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.source_event_id is not null then
    select event.project_id into linked_project_id
    from public.person_timeline_events event where event.id = new.source_event_id;
    if not found or linked_project_id <> parent_project_id then
      raise exception 'CONTEXT_EVIDENCE_EVENT_PROJECT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if new.finding_participant_id is not null then
    select participant.project_id into linked_project_id
    from public.finding_participants participant where participant.id = new.finding_participant_id;
    if not found or linked_project_id <> parent_project_id then
      raise exception 'CONTEXT_EVIDENCE_PARTICIPANT_PROJECT_MISMATCH' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if new.relation_id <> old.relation_id then
      raise exception 'CONTEXT_EVIDENCE_RELATION_IMMUTABLE' using errcode = '22023';
    end if;
    new.created_by := old.created_by;
  elsif coalesce(auth.role(), '') <> 'service_role' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    new.updated_by := auth.uid();
  end if;
  if new.deleted_at is null then
    new.deleted_by := null;
  elsif new.deleted_by is null then
    new.deleted_by := coalesce(auth.uid(), new.updated_by, new.created_by);
  end if;

  return new;
end;
$function$;

create or replace function security_private.touch_context_graph_row_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  new.updated_at := now();
  new.lock_version := old.lock_version + 1;
  return new;
end;
$function$;

create or replace function security_private.audit_context_graph_row_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  before_row jsonb;
  after_row jsonb;
  audit_row jsonb;
begin
  if tg_op = 'DELETE' then
    before_row := to_jsonb(old);
    after_row := null;
    audit_row := before_row;
  elsif tg_op = 'INSERT' then
    before_row := null;
    after_row := to_jsonb(new);
    audit_row := after_row;
  else
    before_row := to_jsonb(old);
    after_row := to_jsonb(new);
    audit_row := after_row;
  end if;

  -- System type seeds have no project scope and intentionally stay out of the
  -- project audit stream.
  if nullif(audit_row ->> 'project_id', '') is not null then
    insert into security_private.context_graph_audit_log (
      project_id, entity_table, entity_id, actor_id, action,
      before_data, after_data
    ) values (
      (audit_row ->> 'project_id')::uuid,
      tg_table_name,
      nullif(audit_row ->> 'id', '')::uuid,
      auth.uid(),
      lower(tg_op),
      before_row,
      after_row
    );
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

create or replace function security_private.bump_context_graph_revision_new_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if current_setting('app.context_graph_backfill', true) = 'on' then
    return null;
  end if;
  insert into public.context_graph_revisions (project_id, revision, updated_at)
  select distinct changed.project_id, 1, now()
  from new_rows changed
  where changed.project_id is not null
  on conflict (project_id) do update
  set revision = public.context_graph_revisions.revision + 1,
      updated_at = excluded.updated_at;
  return null;
end;
$function$;

create or replace function security_private.bump_context_graph_revision_old_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if current_setting('app.context_graph_backfill', true) = 'on' then
    return null;
  end if;
  insert into public.context_graph_revisions (project_id, revision, updated_at)
  select distinct changed.project_id, 1, now()
  from old_rows changed
  where changed.project_id is not null
  on conflict (project_id) do update
  set revision = public.context_graph_revisions.revision + 1,
      updated_at = excluded.updated_at;
  return null;
end;
$function$;

drop trigger if exists context_relation_types_10_prepare on public.context_relation_types;
create trigger context_relation_types_10_prepare
before insert or update on public.context_relation_types
for each row execute function security_private.prepare_context_relation_type_v1();

drop trigger if exists context_relation_types_20_touch on public.context_relation_types;
create trigger context_relation_types_20_touch
before update on public.context_relation_types
for each row execute function security_private.touch_context_graph_row_v1();

drop trigger if exists person_context_relations_10_prepare on public.person_context_relations;
create trigger person_context_relations_10_prepare
before insert or update on public.person_context_relations
for each row execute function security_private.prepare_person_context_relation_v1();

drop trigger if exists person_context_relations_20_touch on public.person_context_relations;
create trigger person_context_relations_20_touch
before update on public.person_context_relations
for each row execute function security_private.touch_context_graph_row_v1();

drop trigger if exists context_relation_evidence_10_prepare on public.context_relation_evidence;
create trigger context_relation_evidence_10_prepare
before insert or update on public.context_relation_evidence
for each row execute function security_private.prepare_context_relation_evidence_v1();

drop trigger if exists context_relation_evidence_20_touch on public.context_relation_evidence;
create trigger context_relation_evidence_20_touch
before update on public.context_relation_evidence
for each row execute function security_private.touch_context_graph_row_v1();

do $audit_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'context_relation_types', 'person_context_relations', 'context_relation_evidence'
  ] loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_90_audit', table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I
       for each row execute function security_private.audit_context_graph_row_v1()',
      table_name || '_90_audit', table_name
    );

    execute format('drop trigger if exists %I on public.%I', table_name || '_95_revision_insert', table_name);
    execute format(
      'create trigger %I after insert on public.%I
       referencing new table as new_rows for each statement
       execute function security_private.bump_context_graph_revision_new_v1()',
      table_name || '_95_revision_insert', table_name
    );

    execute format('drop trigger if exists %I on public.%I', table_name || '_95_revision_update', table_name);
    execute format(
      'create trigger %I after update on public.%I
       referencing new table as new_rows for each statement
       execute function security_private.bump_context_graph_revision_new_v1()',
      table_name || '_95_revision_update', table_name
    );

    execute format('drop trigger if exists %I on public.%I', table_name || '_95_revision_delete', table_name);
    execute format(
      'create trigger %I after delete on public.%I
       referencing old table as old_rows for each statement
       execute function security_private.bump_context_graph_revision_old_v1()',
      table_name || '_95_revision_delete', table_name
    );
  end loop;
end;
$audit_triggers$;

create or replace function security_private.legacy_person_context_type_code_v1(
  p_relation_type text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select case btrim(coalesce(p_relation_type, ''))
    when 'хрещений' then 'godparent'
    when 'хрещена' then 'godparent'
    when 'хрещеник' then 'godparent'
    when 'хрещениця' then 'godparent'
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

  if legacy_row.relation_type in (
    'хрещений', 'хрещена', 'свідок', 'поручитель',
    'священник', 'духовна особа', 'посадова особа', 'повитуха',
    'особа, яка повідомила', 'голова господарства'
  ) then
    source_id := legacy_row.related_person_id;
    target_id := legacy_row.person_id;
  elsif legacy_row.relation_type in ('хрещеник', 'хрещениця') then
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

create or replace function security_private.sync_context_from_association_v1(
  p_association_id uuid,
  p_delete boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  legacy_row public.association_relationships%rowtype;
  type_id uuid;
  context_id uuid;
  actor_id uuid;
  linked_person_relation_id uuid;
begin
  if p_delete then
    update public.context_relation_evidence evidence
    set deleted_at = coalesce(evidence.deleted_at, now()),
        deleted_by = coalesce(evidence.deleted_by, auth.uid())
    from public.person_context_relations relation
    where relation.legacy_source_table = 'association_relationships'
      and relation.legacy_source_id = p_association_id
      and evidence.relation_id = relation.id
      and evidence.deleted_at is null;

    update public.person_context_relations relation
    set deleted_at = coalesce(relation.deleted_at, now()),
        deleted_by = coalesce(relation.deleted_by, auth.uid())
    where relation.legacy_source_table = 'association_relationships'
      and relation.legacy_source_id = p_association_id
      and relation.deleted_at is null
    returning relation.id into context_id;
    return context_id;
  end if;

  select association.* into legacy_row
  from public.association_relationships association
  where association.id = p_association_id;
  if not found then
    return security_private.sync_context_from_association_v1(p_association_id, true);
  end if;

  -- Compatibility associations generated from person_relations are not a
  -- second assertion. Keep the person_relations row as the stable origin.
  if coalesce(legacy_row.metadata ->> 'legacyRelationId', '')
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    linked_person_relation_id := (legacy_row.metadata ->> 'legacyRelationId')::uuid;
    if exists (
      select 1 from public.person_relations relation
      where relation.id = linked_person_relation_id
        and relation.project_id = legacy_row.project_id
    ) then
      select relation.id into context_id
      from public.person_context_relations relation
      where relation.legacy_source_table = 'person_relations'
        and relation.legacy_source_id = linked_person_relation_id;
      return context_id;
    end if;
  end if;

  select relation_type.id into type_id
  from public.context_relation_types relation_type
  where relation_type.project_id is null
    and relation_type.code = case legacy_row.association_type
      when 'godparent' then 'godparent'
      when 'witness' then 'witness'
      when 'neighbor' then 'neighbor'
      when 'household_member' then 'household_member'
      when 'caregiver' then 'caregiver'
      when 'benefactor' then 'benefactor'
      when 'namesake' then 'namesake'
      when 'mentioned_in_source' then 'mentioned_in_source'
      when 'dna_match' then 'dna_match'
      when 'possible_relative' then 'possible_relative'
      when 'guardian_non_parent' then 'guardian_non_parent'
      when 'clergy' then 'clergy'
      when 'official' then 'official'
      else 'other'
    end;

  actor_id := legacy_row.created_by;
  if actor_id is null then
    select project.owner_id into actor_id
    from public.projects project where project.id = legacy_row.project_id;
  end if;

  insert into public.person_context_relations (
    project_id, relation_type_id, source_person_id, target_person_id,
    source_role_label, target_role_label, evidence_status, confidence,
    privacy_status, assertion_kind, notes, metadata,
    legacy_source_table, legacy_source_id, created_by, updated_by,
    deleted_at, deleted_by
  ) values (
    legacy_row.project_id, type_id, legacy_row.person_a_id, legacy_row.person_b_id,
    legacy_row.person_a_role_label, legacy_row.person_b_role_label,
    legacy_row.evidence_status, legacy_row.confidence, legacy_row.privacy_status,
    'legacy_import', legacy_row.notes,
    legacy_row.metadata || jsonb_build_object(
      'legacyTreeId', legacy_row.tree_id,
      'source', 'association_relationships'
    ),
    'association_relationships', legacy_row.id, actor_id, actor_id, null, null
  )
  on conflict (legacy_source_table, legacy_source_id) where legacy_source_id is not null
  do update set
    project_id = excluded.project_id,
    relation_type_id = excluded.relation_type_id,
    source_person_id = excluded.source_person_id,
    target_person_id = excluded.target_person_id,
    source_role_label = excluded.source_role_label,
    target_role_label = excluded.target_role_label,
    evidence_status = excluded.evidence_status,
    confidence = excluded.confidence,
    privacy_status = excluded.privacy_status,
    notes = excluded.notes,
    metadata = public.person_context_relations.metadata || excluded.metadata,
    updated_by = excluded.updated_by,
    deleted_at = null,
    deleted_by = null
  returning id into context_id;

  if legacy_row.source_document_id is not null or legacy_row.source_finding_id is not null then
    insert into public.context_relation_evidence (
      project_id, relation_id, evidence_kind, source_document_id,
      source_finding_id, origin_key, metadata, created_by, updated_by,
      deleted_at, deleted_by
    ) values (
      legacy_row.project_id, context_id,
      case when legacy_row.source_finding_id is not null then 'finding' else 'document' end,
      legacy_row.source_document_id, legacy_row.source_finding_id,
      'association_relationships:' || legacy_row.id::text,
      jsonb_build_object('source', 'association_relationships'),
      actor_id, actor_id, null, null
    )
    on conflict (relation_id, origin_key) where origin_key is not null
    do update set
      evidence_kind = excluded.evidence_kind,
      source_document_id = excluded.source_document_id,
      source_finding_id = excluded.source_finding_id,
      metadata = public.context_relation_evidence.metadata || excluded.metadata,
      updated_by = excluded.updated_by,
      deleted_at = null,
      deleted_by = null;
  else
    update public.context_relation_evidence evidence
    set deleted_at = coalesce(evidence.deleted_at, now()),
        deleted_by = coalesce(evidence.deleted_by, actor_id)
    where evidence.relation_id = context_id
      and evidence.origin_key = 'association_relationships:' || legacy_row.id::text
      and evidence.deleted_at is null;
  end if;

  return context_id;
end;
$function$;

create or replace function security_private.person_relation_context_sync_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    perform security_private.sync_context_from_person_relation_v1(old.id, true);
    return old;
  end if;
  perform security_private.sync_context_from_person_relation_v1(new.id, false);
  return new;
end;
$function$;

create or replace function security_private.association_context_sync_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    -- A tree cascade removes only the obsolete compatibility row. The
    -- project-level social assertion must survive deleting a family-tree view.
    if not exists (
      select 1 from public.family_trees tree where tree.id = old.tree_id
    ) then
      return old;
    end if;
    perform security_private.sync_context_from_association_v1(old.id, true);
    return old;
  end if;
  perform security_private.sync_context_from_association_v1(new.id, false);
  return new;
end;
$function$;

-- Ongoing compatibility: old clients may continue writing either legacy
-- table while the new UI is rolled out. These triggers only project into the
-- context model; they never write family_trees or family graph edges.
drop trigger if exists person_relations_context_graph_sync on public.person_relations;
create trigger person_relations_context_graph_sync
after insert or update of person_id, related_person_id, relation_type, status, evidence_text, notes
on public.person_relations
for each row execute function security_private.person_relation_context_sync_trigger_v1();

drop trigger if exists person_relations_context_graph_delete_sync on public.person_relations;
create trigger person_relations_context_graph_delete_sync
after delete on public.person_relations
for each row execute function security_private.person_relation_context_sync_trigger_v1();

drop trigger if exists association_relationships_context_graph_sync on public.association_relationships;
create trigger association_relationships_context_graph_sync
after insert or update of
  tree_id, person_a_id, person_b_id, association_type, person_a_role_label,
  person_b_role_label, evidence_status, confidence, privacy_status,
  source_document_id, source_finding_id, notes, metadata
on public.association_relationships
for each row execute function security_private.association_context_sync_trigger_v1();

drop trigger if exists association_relationships_context_graph_delete_sync on public.association_relationships;
create trigger association_relationships_context_graph_delete_sync
after delete on public.association_relationships
for each row execute function security_private.association_context_sync_trigger_v1();

-- Idempotent, non-destructive backfill. Existing rows remain untouched in
-- their legacy tables. Re-running the two loops updates the same origin keys.
do $backfill$
declare
  source_id uuid;
begin
  perform set_config('app.context_graph_backfill', 'on', true);

  for source_id in
    select relation.id
    from public.person_relations relation
    where security_private.legacy_person_context_type_code_v1(relation.relation_type) is not null
    order by relation.project_id, relation.id
  loop
    perform security_private.sync_context_from_person_relation_v1(source_id, false);
  end loop;

  for source_id in
    select association.id
    from public.association_relationships association
    order by association.project_id, association.id
  loop
    perform security_private.sync_context_from_association_v1(source_id, false);
  end loop;

  perform set_config('app.context_graph_backfill', 'off', true);

  insert into public.context_graph_revisions (project_id, revision, updated_at)
  select distinct relation.project_id, 1, now()
  from public.person_context_relations relation
  on conflict (project_id) do update
  set revision = public.context_graph_revisions.revision + 1,
      updated_at = excluded.updated_at;
end;
$backfill$;

create or replace function security_private.require_context_project_access_v1(
  p_project_id uuid,
  p_write boolean default false
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    if not exists (select 1 from public.projects project where project.id = p_project_id) then
      raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
    end if;
    return;
  end if;
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_write then
    if not public.can_edit_project(p_project_id) then
      raise exception 'PROJECT_EDIT_REQUIRED' using errcode = '42501';
    end if;
  elsif not public.is_project_member(p_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function security_private.context_relation_evidence_json_v1(
  p_evidence public.context_relation_evidence
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_evidence.id,
    'projectId', p_evidence.project_id,
    'relationId', p_evidence.relation_id,
    'evidenceKind', p_evidence.evidence_kind,
    'sourceDocumentId', p_evidence.source_document_id,
    'sourceFindingId', p_evidence.source_finding_id,
    'sourceEventId', p_evidence.source_event_id,
    'findingParticipantId', p_evidence.finding_participant_id,
    'citationId', p_evidence.citation_id,
    'documentFragmentId', p_evidence.document_fragment_id,
    'sourceLocator', p_evidence.source_locator,
    'excerpt', p_evidence.excerpt,
    'notes', p_evidence.notes,
    'metadata', p_evidence.metadata,
    'lockVersion', p_evidence.lock_version,
    'createdBy', p_evidence.created_by,
    'createdAt', p_evidence.created_at,
    'updatedBy', p_evidence.updated_by,
    'updatedAt', p_evidence.updated_at,
    'deletedAt', p_evidence.deleted_at
  );
$function$;

create or replace function security_private.context_relation_json_v1(
  p_relation public.person_context_relations,
  p_include_evidence boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private
as $function$
  select jsonb_build_object(
    'id', p_relation.id,
    'projectId', p_relation.project_id,
    'relationTypeId', p_relation.relation_type_id,
    'relationTypeCode', relation_type.code,
    'relationTypeLabel', relation_type.label_uk,
    'relationCategory', relation_type.category,
    'directionality', relation_type.directionality,
    'sourcePersonId', p_relation.source_person_id,
    'targetPersonId', p_relation.target_person_id,
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
    'lockVersion', p_relation.lock_version,
    'createdBy', p_relation.created_by,
    'createdAt', p_relation.created_at,
    'updatedBy', p_relation.updated_by,
    'updatedAt', p_relation.updated_at,
    'deletedAt', p_relation.deleted_at,
    'evidence', case when p_include_evidence then coalesce((
      select jsonb_agg(
        security_private.context_relation_evidence_json_v1(evidence)
        order by evidence.created_at, evidence.id
      )
      from public.context_relation_evidence evidence
      where evidence.relation_id = p_relation.id
        and evidence.deleted_at is null
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from public.context_relation_types relation_type
  where relation_type.id = p_relation.relation_type_id;
$function$;

create or replace function security_private.list_context_relation_types_v1(
  p_project_id uuid,
  p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', relation_type.id,
    'projectId', relation_type.project_id,
    'code', relation_type.code,
    'category', relation_type.category,
    'directionality', relation_type.directionality,
    'labelUk', relation_type.label_uk,
    'inverseCode', relation_type.inverse_code,
    'inverseLabelUk', relation_type.inverse_label_uk,
    'sourceRoleUk', relation_type.source_role_uk,
    'targetRoleUk', relation_type.target_role_uk,
    'iconToken', relation_type.icon_token,
    'colorRole', relation_type.color_role,
    'isSystem', relation_type.is_system,
    'isActive', relation_type.is_active,
    'lockVersion', relation_type.lock_version
  ) order by relation_type.is_system desc, relation_type.category, relation_type.label_uk), '[]'::jsonb)
  into result
  from public.context_relation_types relation_type
  where (relation_type.project_id is null or relation_type.project_id = p_project_id)
    and (coalesce(p_include_inactive, false) or relation_type.is_active);
  return result;
end;
$function$;

create or replace function security_private.list_person_context_relations_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_include_deleted boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  can_edit boolean;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);
  if not exists (
    select 1 from public.persons person
    where person.id = p_person_id and person.project_id = p_project_id
  ) then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'CONTEXT_RELATION_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'CONTEXT_RELATION_OFFSET_OUT_OF_RANGE' using errcode = '22023';
  end if;
  can_edit := coalesce(auth.role(), '') = 'service_role' or public.can_edit_project(p_project_id);

  with visible as (
    select relation.*
    from public.person_context_relations relation
    where relation.project_id = p_project_id
      and (relation.source_person_id = p_person_id or relation.target_person_id = p_person_id)
      and (coalesce(p_include_deleted, false) or relation.deleted_at is null)
      and (relation.privacy_status <> 'confidential' or can_edit)
      and (
        can_edit
        or not exists (
          select 1
          from public.persons endpoint
          where endpoint.project_id = relation.project_id
            and endpoint.id in (relation.source_person_id, relation.target_person_id)
            and endpoint.is_living
            and endpoint.privacy_status in ('private', 'confidential')
        )
      )
  ), page as (
    select visible.*
    from visible
    order by visible.updated_at desc, visible.id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(
      security_private.context_relation_json_v1(relation_row, true)
      order by relation_row.updated_at desc, relation_row.id
    )
    from page
    join public.person_context_relations relation_row on relation_row.id = page.id), '[]'::jsonb),
    'total', (select count(*) from visible),
    'revision', coalesce((
      select revision.revision from public.context_graph_revisions revision
      where revision.project_id = p_project_id
    ), 0)
  ) into result;
  return result;
end;
$function$;

create or replace function security_private.save_context_relation_type_v1(
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
  saved public.context_relation_types%rowtype;
  actor_id uuid := auth.uid();
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 100000 then
    raise exception 'CONTEXT_RELATION_TYPE_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  target_id := nullif(p_payload ->> 'id', '')::uuid;

  if target_id is null then
    insert into public.context_relation_types (
      project_id, code, category, directionality, label_uk, inverse_code,
      inverse_label_uk, source_role_uk, target_role_uk, icon_token,
      color_role, is_system, is_active, metadata, created_by, updated_by
    ) values (
      p_project_id, lower(btrim(p_payload ->> 'code')),
      coalesce(nullif(p_payload ->> 'category', ''), 'social'),
      coalesce(nullif(p_payload ->> 'directionality', ''), 'directed'),
      btrim(p_payload ->> 'labelUk'),
      lower(btrim(coalesce(p_payload ->> 'inverseCode', ''))),
      btrim(coalesce(p_payload ->> 'inverseLabelUk', '')),
      btrim(coalesce(p_payload ->> 'sourceRoleUk', '')),
      btrim(coalesce(p_payload ->> 'targetRoleUk', '')),
      btrim(coalesce(p_payload ->> 'iconToken', '')),
      coalesce(nullif(btrim(p_payload ->> 'colorRole'), ''), 'context'),
      false, coalesce((p_payload ->> 'isActive')::boolean, true),
      coalesce(p_payload -> 'metadata', '{}'::jsonb), actor_id, actor_id
    ) returning * into saved;
  else
    if p_expected_lock_version is null then
      raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
    end if;
    update public.context_relation_types relation_type
    set
      code = lower(btrim(p_payload ->> 'code')),
      category = coalesce(nullif(p_payload ->> 'category', ''), relation_type.category),
      directionality = coalesce(nullif(p_payload ->> 'directionality', ''), relation_type.directionality),
      label_uk = btrim(p_payload ->> 'labelUk'),
      inverse_code = lower(btrim(coalesce(p_payload ->> 'inverseCode', ''))),
      inverse_label_uk = btrim(coalesce(p_payload ->> 'inverseLabelUk', '')),
      source_role_uk = btrim(coalesce(p_payload ->> 'sourceRoleUk', '')),
      target_role_uk = btrim(coalesce(p_payload ->> 'targetRoleUk', '')),
      icon_token = btrim(coalesce(p_payload ->> 'iconToken', '')),
      color_role = coalesce(nullif(btrim(p_payload ->> 'colorRole'), ''), relation_type.color_role),
      is_active = coalesce((p_payload ->> 'isActive')::boolean, relation_type.is_active),
      metadata = coalesce(p_payload -> 'metadata', relation_type.metadata),
      updated_by = actor_id
    where relation_type.id = target_id
      and relation_type.project_id = p_project_id
      and not relation_type.is_system
      and relation_type.lock_version = p_expected_lock_version
    returning * into saved;
    if not found then
      raise exception 'CONTEXT_RELATION_TYPE_STALE_OR_NOT_FOUND' using errcode = '40001';
    end if;
  end if;

  return jsonb_build_object(
    'id', saved.id, 'projectId', saved.project_id, 'code', saved.code,
    'category', saved.category, 'directionality', saved.directionality,
    'labelUk', saved.label_uk, 'inverseCode', saved.inverse_code,
    'inverseLabelUk', saved.inverse_label_uk, 'isActive', saved.is_active,
    'lockVersion', saved.lock_version, 'updatedAt', saved.updated_at
  );
end;
$function$;

create or replace function security_private.save_person_context_relation_v1(
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
  type_id uuid;
  saved public.person_context_relations%rowtype;
  actor_id uuid := auth.uid();
  source_id uuid;
  destination_id uuid;
  requested_assertion_kind text;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 200000 then
    raise exception 'CONTEXT_RELATION_PAYLOAD_INVALID' using errcode = '22023';
  end if;

  target_id := nullif(p_payload ->> 'id', '')::uuid;
  source_id := nullif(p_payload ->> 'sourcePersonId', '')::uuid;
  destination_id := nullif(p_payload ->> 'targetPersonId', '')::uuid;
  type_id := nullif(p_payload ->> 'relationTypeId', '')::uuid;
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
  if source_id is null or destination_id is null then
    raise exception 'CONTEXT_RELATION_ENDPOINTS_REQUIRED' using errcode = '22023';
  end if;

  requested_assertion_kind := coalesce(nullif(p_payload ->> 'assertionKind', ''), 'manual');
  if requested_assertion_kind not in ('manual', 'research_hypothesis') then
    raise exception 'CONTEXT_RELATION_ASSERTION_KIND_NOT_CLIENT_WRITABLE' using errcode = '22023';
  end if;

  if target_id is null then
    insert into public.person_context_relations (
      project_id, relation_type_id, source_person_id, target_person_id,
      source_role_label, target_role_label, valid_from, valid_to, period_text,
      evidence_status, confidence, privacy_status, assertion_kind, notes,
      metadata, created_by, updated_by
    ) values (
      p_project_id, type_id, source_id, destination_id,
      btrim(coalesce(p_payload ->> 'sourceRoleLabel', '')),
      btrim(coalesce(p_payload ->> 'targetRoleLabel', '')),
      nullif(p_payload ->> 'validFrom', '')::date,
      nullif(p_payload ->> 'validTo', '')::date,
      btrim(coalesce(p_payload ->> 'periodText', '')),
      coalesce(nullif(p_payload ->> 'evidenceStatus', ''), 'unknown'),
      coalesce((p_payload ->> 'confidence')::integer, 0),
      coalesce(nullif(p_payload ->> 'privacyStatus', ''), 'project'),
      requested_assertion_kind, btrim(coalesce(p_payload ->> 'notes', '')),
      coalesce(p_payload -> 'metadata', '{}'::jsonb), actor_id, actor_id
    ) returning * into saved;
  else
    if p_expected_lock_version is null then
      raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
    end if;
    update public.person_context_relations relation
    set
      relation_type_id = type_id,
      source_person_id = source_id,
      target_person_id = destination_id,
      source_role_label = btrim(coalesce(p_payload ->> 'sourceRoleLabel', '')),
      target_role_label = btrim(coalesce(p_payload ->> 'targetRoleLabel', '')),
      valid_from = nullif(p_payload ->> 'validFrom', '')::date,
      valid_to = nullif(p_payload ->> 'validTo', '')::date,
      period_text = btrim(coalesce(p_payload ->> 'periodText', '')),
      evidence_status = coalesce(nullif(p_payload ->> 'evidenceStatus', ''), 'unknown'),
      confidence = coalesce((p_payload ->> 'confidence')::integer, 0),
      privacy_status = coalesce(nullif(p_payload ->> 'privacyStatus', ''), 'project'),
      assertion_kind = requested_assertion_kind,
      notes = btrim(coalesce(p_payload ->> 'notes', '')),
      metadata = coalesce(p_payload -> 'metadata', '{}'::jsonb),
      updated_by = actor_id
    where relation.id = target_id
      and relation.project_id = p_project_id
      and relation.deleted_at is null
      and relation.lock_version = p_expected_lock_version
    returning * into saved;
    if not found then
      raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001';
    end if;
  end if;

  return security_private.context_relation_json_v1(saved, true);
end;
$function$;

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
declare saved public.person_context_relations%rowtype;
begin
  perform security_private.require_context_project_access_v1(p_project_id, true);
  if p_expected_lock_version is null then
    raise exception 'EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;
  update public.person_context_relations relation
  set deleted_at = now(), deleted_by = auth.uid(), updated_by = auth.uid()
  where relation.id = p_relation_id
    and relation.project_id = p_project_id
    and relation.deleted_at is null
    and relation.lock_version = p_expected_lock_version
  returning * into saved;
  if not found then
    raise exception 'CONTEXT_RELATION_STALE_OR_NOT_FOUND' using errcode = '40001';
  end if;
  update public.context_relation_evidence evidence
  set deleted_at = coalesce(evidence.deleted_at, now()),
      deleted_by = coalesce(evidence.deleted_by, auth.uid()),
      updated_by = auth.uid()
  where evidence.relation_id = saved.id and evidence.deleted_at is null;
  return security_private.context_relation_json_v1(saved, false);
end;
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
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 200000 then
    raise exception 'CONTEXT_EVIDENCE_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  target_id := nullif(p_payload ->> 'id', '')::uuid;
  target_relation_id := nullif(p_payload ->> 'relationId', '')::uuid;
  if target_relation_id is null then
    raise exception 'CONTEXT_RELATION_ID_REQUIRED' using errcode = '22023';
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

-- Public Data API entry points are narrow SECURITY INVOKER facades. Elevated
-- bodies live outside the exposed schema and repeat all membership checks.
create or replace function public.list_context_relation_types_v1(
  p_project_id uuid,
  p_include_inactive boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_context_relation_types_v1($1, $2);
$wrapper$;

create or replace function public.list_person_context_relations_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_include_deleted boolean default false,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_person_context_relations_v1($1, $2, $3, $4, $5);
$wrapper$;

create or replace function public.save_context_relation_type_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.save_context_relation_type_v1($1, $2, $3);
$wrapper$;

create or replace function public.save_person_context_relation_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.save_person_context_relation_v1($1, $2, $3);
$wrapper$;

create or replace function public.archive_person_context_relation_v1(
  p_project_id uuid,
  p_relation_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.archive_person_context_relation_v1($1, $2, $3);
$wrapper$;

create or replace function public.save_context_relation_evidence_v1(
  p_project_id uuid,
  p_payload jsonb,
  p_expected_lock_version integer default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.save_context_relation_evidence_v1($1, $2, $3);
$wrapper$;

create or replace function public.archive_context_relation_evidence_v1(
  p_project_id uuid,
  p_evidence_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.archive_context_relation_evidence_v1($1, $2, $3);
$wrapper$;

alter table public.context_relation_types enable row level security;
alter table public.person_context_relations enable row level security;
alter table public.context_relation_evidence enable row level security;
alter table public.context_graph_revisions enable row level security;

drop policy if exists context_relation_types_select_members on public.context_relation_types;
create policy context_relation_types_select_members
on public.context_relation_types for select to authenticated
using (
  project_id is null
  or (select public.is_project_member(project_id))
);

drop policy if exists context_relation_types_insert_editors on public.context_relation_types;
create policy context_relation_types_insert_editors
on public.context_relation_types for insert to authenticated
with check (
  project_id is not null
  and not is_system
  and (select public.can_edit_project(project_id))
);

drop policy if exists context_relation_types_update_editors on public.context_relation_types;
create policy context_relation_types_update_editors
on public.context_relation_types for update to authenticated
using (
  project_id is not null
  and not is_system
  and (select public.can_edit_project(project_id))
)
with check (
  project_id is not null
  and not is_system
  and (select public.can_edit_project(project_id))
);

drop policy if exists context_relation_types_delete_editors on public.context_relation_types;
create policy context_relation_types_delete_editors
on public.context_relation_types for delete to authenticated
using (
  project_id is not null
  and not is_system
  and (select public.can_edit_project(project_id))
);

drop policy if exists person_context_relations_select_members on public.person_context_relations;
create policy person_context_relations_select_members
on public.person_context_relations for select to authenticated
using (
  (select public.is_project_member(project_id))
  and (privacy_status <> 'confidential' or (select public.can_edit_project(project_id)))
  and (
    (select public.can_edit_project(project_id))
    or not exists (
      select 1
      from public.persons endpoint
      where endpoint.project_id = person_context_relations.project_id
        and endpoint.id in (
          person_context_relations.source_person_id,
          person_context_relations.target_person_id
        )
        and endpoint.is_living
        and endpoint.privacy_status in ('private', 'confidential')
    )
  )
);

drop policy if exists person_context_relations_insert_editors on public.person_context_relations;
create policy person_context_relations_insert_editors
on public.person_context_relations for insert to authenticated
with check ((select public.can_edit_project(project_id)));

drop policy if exists person_context_relations_update_editors on public.person_context_relations;
create policy person_context_relations_update_editors
on public.person_context_relations for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));

drop policy if exists person_context_relations_delete_editors on public.person_context_relations;
create policy person_context_relations_delete_editors
on public.person_context_relations for delete to authenticated
using ((select public.can_edit_project(project_id)));

drop policy if exists context_relation_evidence_select_members on public.context_relation_evidence;
create policy context_relation_evidence_select_members
on public.context_relation_evidence for select to authenticated
using (
  (select public.is_project_member(project_id))
  and exists (
    select 1
    from public.person_context_relations relation
    where relation.id = context_relation_evidence.relation_id
      and relation.project_id = context_relation_evidence.project_id
      and (
        relation.privacy_status <> 'confidential'
        or (select public.can_edit_project(context_relation_evidence.project_id))
      )
  )
);

drop policy if exists context_relation_evidence_insert_editors on public.context_relation_evidence;
create policy context_relation_evidence_insert_editors
on public.context_relation_evidence for insert to authenticated
with check ((select public.can_edit_project(project_id)));

drop policy if exists context_relation_evidence_update_editors on public.context_relation_evidence;
create policy context_relation_evidence_update_editors
on public.context_relation_evidence for update to authenticated
using ((select public.can_edit_project(project_id)))
with check ((select public.can_edit_project(project_id)));

drop policy if exists context_relation_evidence_delete_editors on public.context_relation_evidence;
create policy context_relation_evidence_delete_editors
on public.context_relation_evidence for delete to authenticated
using ((select public.can_edit_project(project_id)));

drop policy if exists context_graph_revisions_select_members on public.context_graph_revisions;
create policy context_graph_revisions_select_members
on public.context_graph_revisions for select to authenticated
using ((select public.is_project_member(project_id)));

-- RPC-only client surface. RLS remains a fail-safe for future internal grants,
-- while service_role retains maintenance access.
revoke all on table
  public.context_relation_types,
  public.person_context_relations,
  public.context_relation_evidence,
  public.context_graph_revisions
from public, anon, authenticated;

grant all on table
  public.context_relation_types,
  public.person_context_relations,
  public.context_relation_evidence,
  public.context_graph_revisions
to service_role;

do $function_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure as signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'security_private'
      and procedure.proname = any(array[
        'prepare_context_relation_type_v1',
        'prepare_person_context_relation_v1',
        'prepare_context_relation_evidence_v1',
        'touch_context_graph_row_v1',
        'audit_context_graph_row_v1',
        'bump_context_graph_revision_new_v1',
        'bump_context_graph_revision_old_v1',
        'legacy_person_context_type_code_v1',
        'sync_context_from_person_relation_v1',
        'sync_context_from_association_v1',
        'person_relation_context_sync_trigger_v1',
        'association_context_sync_trigger_v1',
        'require_context_project_access_v1',
        'context_relation_evidence_json_v1',
        'context_relation_json_v1',
        'list_context_relation_types_v1',
        'list_person_context_relations_v1',
        'save_context_relation_type_v1',
        'save_person_context_relation_v1',
        'archive_person_context_relation_v1',
        'save_context_relation_evidence_v1',
        'archive_context_relation_evidence_v1'
      ]::text[])
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_record.signature
    );
  end loop;
end;
$function_acl$;

grant execute on function security_private.list_context_relation_types_v1(uuid,boolean)
  to authenticated, service_role;
grant execute on function security_private.list_person_context_relations_v1(uuid,uuid,boolean,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.save_context_relation_type_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function security_private.save_person_context_relation_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function security_private.archive_person_context_relation_v1(uuid,uuid,integer)
  to authenticated, service_role;
grant execute on function security_private.save_context_relation_evidence_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function security_private.archive_context_relation_evidence_v1(uuid,uuid,integer)
  to authenticated, service_role;

revoke all on function public.list_context_relation_types_v1(uuid,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.list_person_context_relations_v1(uuid,uuid,boolean,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_context_relation_type_v1(uuid,jsonb,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_person_context_relation_v1(uuid,jsonb,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.archive_person_context_relation_v1(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.save_context_relation_evidence_v1(uuid,jsonb,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.archive_context_relation_evidence_v1(uuid,uuid,integer)
  from public, anon, authenticated, service_role;

grant execute on function public.list_context_relation_types_v1(uuid,boolean)
  to authenticated, service_role;
grant execute on function public.list_person_context_relations_v1(uuid,uuid,boolean,integer,integer)
  to authenticated, service_role;
grant execute on function public.save_context_relation_type_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function public.save_person_context_relation_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function public.archive_person_context_relation_v1(uuid,uuid,integer)
  to authenticated, service_role;
grant execute on function public.save_context_relation_evidence_v1(uuid,jsonb,integer)
  to authenticated, service_role;
grant execute on function public.archive_context_relation_evidence_v1(uuid,uuid,integer)
  to authenticated, service_role;

-- Extend the durable asynchronous project-deletion contract in dependency
-- order: evidence -> relation -> custom types. Revision rows are independent.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
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
$$;

revoke execute on function private.project_deletion_phase_names()
  from public, anon, authenticated;

do $coverage$
declare uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if coalesce(cardinality(uncovered_tables), 0) > 0 then
    raise exception 'PROJECT_DELETION_PHASES_MISSING_TABLES: %',
      array_to_string(uncovered_tables, ', ');
  end if;
end;
$coverage$;

notify pgrst, 'reload schema';

analyze public.context_relation_types;
analyze public.person_context_relations;
analyze public.context_relation_evidence;
analyze public.context_graph_revisions;

commit;
