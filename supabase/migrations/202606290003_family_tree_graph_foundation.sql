begin;

-- Family tree graph foundation.
-- The existing persons table stays the canonical person profile table.
-- These tables model tree membership, family groups, parent sets and
-- evidence-backed graph edges for future tree canvas and GEDCOM import/export.

create unique index if not exists persons_id_project_id_uq
  on public.persons (id, project_id);

create table if not exists public.family_trees (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  title text not null default '',
  description text not null default '',
  root_person_id uuid references public.persons(id) on delete set null,
  is_default boolean not null default false,
  privacy_status text not null default 'private'
    check (privacy_status in ('private', 'project', 'public', 'confidential')),
  settings jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists family_trees_id_project_id_uq
  on public.family_trees (id, project_id);
create unique index if not exists family_trees_default_project_uq
  on public.family_trees (project_id)
  where is_default;
create index if not exists family_trees_project_idx
  on public.family_trees (project_id, created_at desc);
create index if not exists family_trees_root_person_idx
  on public.family_trees (root_person_id);

create table if not exists public.family_tree_persons (
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  person_id uuid not null,
  member_role text not null default 'member'
    check (member_role in ('root', 'member', 'placeholder', 'hidden')),
  display_order integer not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now(),
  primary key (tree_id, person_id),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (person_id, project_id)
    references public.persons(id, project_id) on delete cascade
);

create index if not exists family_tree_persons_person_idx
  on public.family_tree_persons (person_id);
create index if not exists family_tree_persons_project_idx
  on public.family_tree_persons (project_id, tree_id);

create table if not exists public.family_groups (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  group_type text not null default 'couple'
    check (group_type in (
      'couple',
      'single_parent',
      'unknown_partner',
      'adoption_family',
      'foster_family',
      'guardian_family',
      'research_group',
      'other'
    )),
  display_label text not null default '',
  primary_partner_1_id uuid references public.persons(id) on delete set null,
  primary_partner_2_id uuid references public.persons(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  check (
    primary_partner_1_id is null
    or primary_partner_2_id is null
    or primary_partner_1_id <> primary_partner_2_id
  )
);

create unique index if not exists family_groups_id_project_id_uq
  on public.family_groups (id, project_id);
create index if not exists family_groups_tree_idx
  on public.family_groups (tree_id, group_type);
create index if not exists family_groups_partner_1_idx
  on public.family_groups (primary_partner_1_id);
create index if not exists family_groups_partner_2_idx
  on public.family_groups (primary_partner_2_id);

create table if not exists public.family_group_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  family_group_id uuid not null,
  person_id uuid not null,
  member_role text not null default 'member'
    check (member_role in ('partner', 'parent', 'child', 'member', 'unknown')),
  display_order integer not null default 0,
  notes text not null default '',
  created_at timestamptz not null default now(),
  primary key (family_group_id, person_id, member_role),
  foreign key (family_group_id, project_id)
    references public.family_groups(id, project_id) on delete cascade,
  foreign key (person_id, project_id)
    references public.persons(id, project_id) on delete cascade
);

create index if not exists family_group_members_person_idx
  on public.family_group_members (person_id);
create index if not exists family_group_members_project_idx
  on public.family_group_members (project_id, family_group_id);

create table if not exists public.partner_relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  family_group_id uuid references public.family_groups(id) on delete set null,
  person_a_id uuid not null,
  person_b_id uuid not null,
  relationship_type text not null default 'unknown'
    check (relationship_type in (
      'marriage',
      'civil_partnership',
      'cohabitation',
      'engagement',
      'dating',
      'temporary_relationship',
      'divorced',
      'separated',
      'annulled',
      'widowhood',
      'unknown',
      'other'
    )),
  status text not null default 'unknown'
    check (status in ('active', 'ended', 'unknown')),
  start_date text not null default '',
  start_place text not null default '',
  end_date text not null default '',
  end_place text not null default '',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 0 check (confidence between 0 and 100),
  is_primary_for_display boolean not null default false,
  privacy_status text not null default 'private'
    check (privacy_status in ('private', 'project', 'public', 'confidential')),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (person_a_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  foreign key (person_b_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  check (person_a_id <> person_b_id)
);

create index if not exists partner_relationships_tree_idx
  on public.partner_relationships (tree_id, updated_at desc);
create index if not exists partner_relationships_person_a_idx
  on public.partner_relationships (person_a_id);
create index if not exists partner_relationships_person_b_idx
  on public.partner_relationships (person_b_id);
create unique index if not exists partner_relationships_pair_type_uq
  on public.partner_relationships (
    tree_id,
    least(person_a_id, person_b_id),
    greatest(person_a_id, person_b_id),
    relationship_type,
    coalesce(family_group_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create table if not exists public.parent_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  child_id uuid not null,
  family_group_id uuid references public.family_groups(id) on delete set null,
  set_type text not null default 'biological'
    check (set_type in (
      'biological',
      'genetic',
      'birth_or_gestational',
      'adoptive',
      'foster',
      'step',
      'guardian',
      'social',
      'legal',
      'unknown',
      'other'
    )),
  is_preferred_for_display boolean not null default false,
  is_default_for_pedigree boolean not null default false,
  display_order integer not null default 0,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (child_id, project_id)
    references public.persons(id, project_id) on delete cascade
);

create unique index if not exists parent_sets_id_project_id_uq
  on public.parent_sets (id, project_id);
create index if not exists parent_sets_tree_child_idx
  on public.parent_sets (tree_id, child_id, display_order);
create unique index if not exists parent_sets_default_pedigree_uq
  on public.parent_sets (tree_id, child_id)
  where is_default_for_pedigree;

create table if not exists public.parent_child_relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  parent_id uuid not null,
  child_id uuid not null,
  parent_set_id uuid not null,
  family_group_id uuid references public.family_groups(id) on delete set null,
  relationship_type text not null default 'biological'
    check (relationship_type in (
      'biological',
      'genetic_father',
      'genetic_mother',
      'gestational_parent',
      'birth_parent',
      'adoptive',
      'foster',
      'step',
      'guardian',
      'social_parent',
      'legal_parent',
      'donor',
      'surrogate',
      'presumed',
      'unknown',
      'other'
    )),
  parent_role_label text not null default 'parent'
    check (parent_role_label in (
      'father',
      'mother',
      'parent',
      'guardian',
      'stepfather',
      'stepmother',
      'adoptive_father',
      'adoptive_mother',
      'custom'
    )),
  start_date text not null default '',
  end_date text not null default '',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 0 check (confidence between 0 and 100),
  is_primary_for_display boolean not null default false,
  is_bloodline boolean not null default true,
  is_legal boolean not null default false,
  is_social boolean not null default false,
  privacy_status text not null default 'private'
    check (privacy_status in ('private', 'project', 'public', 'confidential')),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (parent_set_id, project_id)
    references public.parent_sets(id, project_id) on delete cascade,
  foreign key (parent_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  foreign key (child_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  check (parent_id <> child_id)
);

create index if not exists parent_child_relationships_tree_idx
  on public.parent_child_relationships (tree_id, updated_at desc);
create index if not exists parent_child_relationships_parent_idx
  on public.parent_child_relationships (parent_id);
create index if not exists parent_child_relationships_child_idx
  on public.parent_child_relationships (child_id);
create index if not exists parent_child_relationships_parent_set_idx
  on public.parent_child_relationships (parent_set_id);
create unique index if not exists parent_child_relationships_unique_edge_uq
  on public.parent_child_relationships (tree_id, parent_id, child_id, relationship_type, parent_set_id);

create table if not exists public.association_relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  person_a_id uuid not null,
  person_b_id uuid not null,
  association_type text not null default 'other'
    check (association_type in (
      'godparent',
      'witness',
      'neighbor',
      'household_member',
      'caregiver',
      'benefactor',
      'namesake',
      'mentioned_in_source',
      'dna_match',
      'possible_relative',
      'guardian_non_parent',
      'clergy',
      'official',
      'other'
    )),
  person_a_role_label text not null default '',
  person_b_role_label text not null default '',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 0 check (confidence between 0 and 100),
  privacy_status text not null default 'private'
    check (privacy_status in ('private', 'project', 'public', 'confidential')),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (person_a_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  foreign key (person_b_id, project_id)
    references public.persons(id, project_id) on delete cascade,
  check (person_a_id <> person_b_id)
);

create index if not exists association_relationships_tree_idx
  on public.association_relationships (tree_id, updated_at desc);
create index if not exists association_relationships_person_a_idx
  on public.association_relationships (person_a_id);
create index if not exists association_relationships_person_b_idx
  on public.association_relationships (person_b_id);
create unique index if not exists association_relationships_unique_edge_uq
  on public.association_relationships (tree_id, person_a_id, person_b_id, association_type);

create table if not exists public.tree_layout_positions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  view_key text not null default 'family',
  person_id uuid not null,
  occurrence_key text not null default '',
  x numeric not null default 0,
  y numeric not null default 0,
  is_collapsed boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  updated_by uuid not null default auth.uid() references public.profiles(user_id),
  updated_at timestamptz not null default now(),
  foreign key (tree_id, project_id)
    references public.family_trees(id, project_id) on delete cascade,
  foreign key (person_id, project_id)
    references public.persons(id, project_id) on delete cascade
);

create unique index if not exists tree_layout_positions_occurrence_uq
  on public.tree_layout_positions (tree_id, view_key, person_id, occurrence_key);
create index if not exists tree_layout_positions_project_idx
  on public.tree_layout_positions (project_id, tree_id, view_key);

create table if not exists public.gedcom_import_batches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid references public.family_trees(id) on delete set null,
  file_name text not null default '',
  gedcom_version text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'previewed', 'importing', 'completed', 'failed', 'cancelled')),
  imported_people integer not null default 0,
  imported_families integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  raw_metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists gedcom_import_batches_project_idx
  on public.gedcom_import_batches (project_id, created_at desc);
create index if not exists gedcom_import_batches_tree_idx
  on public.gedcom_import_batches (tree_id);

create table if not exists public.gedcom_xref_maps (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid references public.family_trees(id) on delete cascade,
  import_batch_id uuid references public.gedcom_import_batches(id) on delete cascade,
  gedcom_xref text not null,
  gedcom_record_type text not null default '',
  internal_table text not null,
  internal_id uuid not null,
  raw_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists gedcom_xref_maps_batch_xref_uq
  on public.gedcom_xref_maps (import_batch_id, gedcom_xref);
create index if not exists gedcom_xref_maps_internal_idx
  on public.gedcom_xref_maps (project_id, internal_table, internal_id);

create table if not exists public.family_tree_merge_history (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid references public.family_trees(id) on delete set null,
  survivor_person_id uuid references public.persons(id) on delete set null,
  merged_person_id uuid references public.persons(id) on delete set null,
  moved_edges jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now()
);

create index if not exists family_tree_merge_history_project_idx
  on public.family_tree_merge_history (project_id, created_at desc);

create table if not exists public.family_tree_research_issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid references public.family_trees(id) on delete cascade,
  person_id uuid references public.persons(id) on delete cascade,
  relationship_table text not null default '',
  relationship_id uuid,
  issue_type text not null,
  severity text not null default 'warning'
    check (severity in ('info', 'warning', 'critical', 'needs_review')),
  title text not null default '',
  description text not null default '',
  status text not null default 'open'
    check (status in ('open', 'ignored', 'resolved')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(user_id)
);

create index if not exists family_tree_research_issues_project_idx
  on public.family_tree_research_issues (project_id, status, severity);
create index if not exists family_tree_research_issues_tree_idx
  on public.family_tree_research_issues (tree_id, status);
create index if not exists family_tree_research_issues_person_idx
  on public.family_tree_research_issues (person_id);

create or replace function public.prevent_bloodline_parent_cycle()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cycle_found boolean;
begin
  if new.parent_id = new.child_id then
    raise exception 'PARENT_CHILD_SELF_RELATION' using errcode = '23514';
  end if;

  if new.is_bloodline and new.evidence_status <> 'disproven' then
    with recursive descendants(person_id, depth) as (
      select rel.child_id, 1
      from public.parent_child_relationships rel
      where rel.tree_id = new.tree_id
        and rel.parent_id = new.child_id
        and rel.is_bloodline
        and rel.evidence_status <> 'disproven'
        and rel.id is distinct from new.id

      union

      select rel.child_id, descendants.depth + 1
      from public.parent_child_relationships rel
      join descendants on descendants.person_id = rel.parent_id
      where rel.tree_id = new.tree_id
        and rel.is_bloodline
        and rel.evidence_status <> 'disproven'
        and rel.id is distinct from new.id
        and descendants.depth < 128
    )
    select exists (
      select 1 from descendants where person_id = new.parent_id
    ) into cycle_found;

    if cycle_found then
      raise exception 'BLOODLINE_PARENT_CYCLE' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists parent_child_relationships_prevent_cycle
  on public.parent_child_relationships;
create trigger parent_child_relationships_prevent_cycle
before insert or update of parent_id, child_id, tree_id, is_bloodline, evidence_status
on public.parent_child_relationships
for each row
execute function public.prevent_bloodline_parent_cycle();

create or replace function public.ensure_default_family_tree(target_project_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  existing_tree_id uuid;
  created_tree_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if not public.can_edit_project(target_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select id
    into existing_tree_id
  from public.family_trees
  where project_id = target_project_id
    and is_default
  limit 1;

  if existing_tree_id is not null then
    return existing_tree_id;
  end if;

  insert into public.family_trees (
    project_id,
    title,
    description,
    is_default,
    privacy_status,
    created_by
  )
  values (
    target_project_id,
    'Родове дерево',
    '',
    true,
    'private',
    auth.uid()
  )
  returning id into created_tree_id;

  return created_tree_id;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'family_trees',
    'family_tree_persons',
    'family_groups',
    'family_group_members',
    'partner_relationships',
    'parent_sets',
    'parent_child_relationships',
    'association_relationships',
    'tree_layout_positions',
    'gedcom_import_batches',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'family_tree_research_issues'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);

    execute format('drop policy if exists %I on public.%I', table_name || '_select_members', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated
       using ((select public.is_project_member(project_id)))',
      table_name || '_select_members',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_insert_editors', table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated
       with check ((select public.can_edit_project(project_id)))',
      table_name || '_insert_editors',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_update_editors', table_name);
    execute format(
      'create policy %I on public.%I for update to authenticated
       using ((select public.can_edit_project(project_id)))
       with check ((select public.can_edit_project(project_id)))',
      table_name || '_update_editors',
      table_name
    );

    execute format('drop policy if exists %I on public.%I', table_name || '_delete_editors', table_name);
    execute format(
      'create policy %I on public.%I for delete to authenticated
       using ((select public.can_edit_project(project_id)))',
      table_name || '_delete_editors',
      table_name
    );
  end loop;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'family_trees',
    'family_groups',
    'partner_relationships',
    'parent_sets',
    'parent_child_relationships',
    'association_relationships',
    'tree_layout_positions',
    'gedcom_import_batches'
  ]
  loop
    execute format('drop trigger if exists %I on public.%I', table_name || '_set_updated_at', table_name);
    execute format(
      'create trigger %I before update on public.%I
       for each row execute function public.set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  end loop;
end;
$$;

revoke execute on function public.prevent_bloodline_parent_cycle() from public, anon, authenticated;
revoke execute on function public.ensure_default_family_tree(uuid) from public, anon;
grant execute on function public.ensure_default_family_tree(uuid) to authenticated;

grant select, insert, update, delete on
  public.family_trees,
  public.family_tree_persons,
  public.family_groups,
  public.family_group_members,
  public.partner_relationships,
  public.parent_sets,
  public.parent_child_relationships,
  public.association_relationships,
  public.tree_layout_positions,
  public.gedcom_import_batches,
  public.gedcom_xref_maps,
  public.family_tree_merge_history,
  public.family_tree_research_issues
to authenticated;

commit;
