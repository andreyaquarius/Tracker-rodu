begin;

-- Keep the current "Persons -> Relations" workflow compatible with the
-- future family tree graph. The UI can continue writing person_relations,
-- while these triggers maintain graph-ready edges in the new tables.

alter table public.persons
  add column if not exists is_living boolean not null default false;

alter table public.persons
  add column if not exists privacy_status text not null default 'private';

do $$
begin
  alter table public.persons
    add constraint persons_privacy_status_check
    check (privacy_status in ('private', 'project', 'public', 'confidential'));
exception
  when duplicate_object then null;
end;
$$;

create table if not exists public.legacy_person_relation_graph_edges (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  relation_id uuid not null references public.person_relations(id) on delete cascade,
  tree_id uuid not null references public.family_trees(id) on delete cascade,
  edge_kind text not null check (edge_kind in ('parent_child', 'partner', 'association')),
  edge_id uuid not null,
  created_at timestamptz not null default now()
);

create unique index if not exists legacy_person_relation_graph_edges_unique_uq
  on public.legacy_person_relation_graph_edges (relation_id, edge_kind, edge_id);
create index if not exists legacy_person_relation_graph_edges_project_idx
  on public.legacy_person_relation_graph_edges (project_id, relation_id);
create index if not exists legacy_person_relation_graph_edges_edge_idx
  on public.legacy_person_relation_graph_edges (edge_kind, edge_id);

create unique index if not exists family_groups_couple_pair_uq
  on public.family_groups (
    tree_id,
    least(primary_partner_1_id, primary_partner_2_id),
    greatest(primary_partner_1_id, primary_partner_2_id)
  )
  where group_type = 'couple'
    and primary_partner_1_id is not null
    and primary_partner_2_id is not null;

create or replace function public.family_tree_evidence_status_from_legacy(legacy_status text)
returns text
language sql
immutable
set search_path = public
as $$
  select case legacy_status
    when 'доведено' then 'proven'
    when 'імовірно' then 'likely'
    when 'сумнівно' then 'disputed'
    when 'спростовано' then 'disproven'
    else 'unknown'
  end;
$$;

create or replace function public.family_tree_confidence_for_evidence(evidence_status text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case evidence_status
    when 'proven' then 100
    when 'likely' then 75
    when 'disputed' then 35
    when 'disproven' then 0
    else 50
  end;
$$;

create or replace function public.family_tree_default_for_project(
  target_project_id uuid,
  actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_tree_id uuid;
begin
  select id
    into target_tree_id
  from public.family_trees
  where project_id = target_project_id
    and is_default
  limit 1;

  if target_tree_id is not null then
    return target_tree_id;
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
    actor_id
  )
  returning id into target_tree_id;

  return target_tree_id;
end;
$$;

create or replace function public.family_tree_member_ensure(
  target_project_id uuid,
  target_tree_id uuid,
  target_person_id uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.family_tree_persons (
    project_id,
    tree_id,
    person_id,
    member_role
  )
  values (
    target_project_id,
    target_tree_id,
    target_person_id,
    'member'
  )
  on conflict (tree_id, person_id) do nothing;
$$;

create or replace function public.family_tree_remove_legacy_relation_edges(
  target_relation_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  mapped record;
begin
  for mapped in
    select *
    from public.legacy_person_relation_graph_edges
    where relation_id = target_relation_id
  loop
    delete from public.legacy_person_relation_graph_edges
    where id = mapped.id;

    if exists (
      select 1
      from public.legacy_person_relation_graph_edges
      where edge_kind = mapped.edge_kind
        and edge_id = mapped.edge_id
    ) then
      continue;
    end if;

    if mapped.edge_kind = 'parent_child' then
      delete from public.parent_child_relationships
      where id = mapped.edge_id;
    elsif mapped.edge_kind = 'partner' then
      delete from public.partner_relationships
      where id = mapped.edge_id;
    elsif mapped.edge_kind = 'association' then
      delete from public.association_relationships
      where id = mapped.edge_id;
    end if;
  end loop;
end;
$$;

create or replace function public.family_tree_sync_person_projection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  primary_name_id uuid;
  person_full_name text;
  person_evidence_status text;
begin
  person_full_name := nullif(trim(new.full_name), '');
  if person_full_name is null then
    person_full_name := nullif(trim(concat_ws(' ', new.surname, new.given_name, new.patronymic)), '');
  end if;
  person_full_name := coalesce(person_full_name, '');
  person_evidence_status := case new.status
    when 'доведена' then 'proven'
    when 'частково доведена' then 'likely'
    when 'сумнівна' then 'disputed'
    when 'спростована' then 'disproven'
    else 'unknown'
  end;

  select id
    into primary_name_id
  from public.person_names
  where person_id = new.id
    and is_primary
  order by created_at
  limit 1;

  if primary_name_id is null then
    insert into public.person_names (
      project_id,
      person_id,
      name_type,
      language_code,
      script_code,
      surname,
      given_name,
      patronymic,
      full_name,
      original_text,
      is_primary,
      is_preferred,
      evidence_status,
      confidence,
      metadata
    )
    values (
      new.project_id,
      new.id,
      'primary',
      'uk',
      'Cyrl',
      coalesce(new.surname, ''),
      coalesce(new.given_name, ''),
      coalesce(new.patronymic, ''),
      person_full_name,
      person_full_name,
      true,
      true,
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      jsonb_build_object('source', 'persons_projection')
    );
  else
    update public.person_names
      set surname = coalesce(new.surname, ''),
          given_name = coalesce(new.given_name, ''),
          patronymic = coalesce(new.patronymic, ''),
          full_name = person_full_name,
          original_text = coalesce(nullif(original_text, ''), person_full_name),
          is_preferred = true,
          evidence_status = person_evidence_status,
          confidence = public.family_tree_confidence_for_evidence(person_evidence_status),
          metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('source', 'persons_projection'),
          updated_at = now()
    where id = primary_name_id;
  end if;

  delete from public.person_timeline_events
  where person_id = new.id
    and metadata ->> 'source' = 'persons_projection';

  if coalesce(new.birth_date, '') <> ''
    or coalesce(new.birth_year_from, '') <> ''
    or coalesce(new.birth_year_to, '') <> ''
    or coalesce(new.birth_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id,
      person_id,
      event_type,
      title,
      event_date,
      date_from,
      date_to,
      date_text,
      place_name,
      event_role,
      evidence_status,
      confidence,
      metadata
    )
    values (
      new.project_id,
      new.id,
      'birth',
      'Народження',
      coalesce(new.birth_date, ''),
      coalesce(new.birth_year_from, ''),
      coalesce(new.birth_year_to, ''),
      coalesce(nullif(new.birth_date, ''), concat_ws('–', nullif(new.birth_year_from, ''), nullif(new.birth_year_to, ''))),
      coalesce(new.birth_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.marriage_date, '') <> ''
    or coalesce(new.marriage_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id,
      person_id,
      event_type,
      title,
      event_date,
      date_text,
      place_name,
      event_role,
      evidence_status,
      confidence,
      metadata
    )
    values (
      new.project_id,
      new.id,
      'marriage',
      'Шлюб',
      coalesce(new.marriage_date, ''),
      coalesce(new.marriage_date, ''),
      coalesce(new.marriage_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.death_date, '') <> ''
    or coalesce(new.death_year_from, '') <> ''
    or coalesce(new.death_year_to, '') <> ''
    or coalesce(new.death_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id,
      person_id,
      event_type,
      title,
      event_date,
      date_from,
      date_to,
      date_text,
      place_name,
      event_role,
      evidence_status,
      confidence,
      metadata
    )
    values (
      new.project_id,
      new.id,
      'death',
      'Смерть',
      coalesce(new.death_date, ''),
      coalesce(new.death_year_from, ''),
      coalesce(new.death_year_to, ''),
      coalesce(nullif(new.death_date, ''), concat_ws('–', nullif(new.death_year_from, ''), nullif(new.death_year_to, ''))),
      coalesce(new.death_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.residence_places, '') <> '' then
    insert into public.person_timeline_events (
      project_id,
      person_id,
      event_type,
      title,
      place_name,
      event_role,
      evidence_status,
      confidence,
      metadata
    )
    values (
      new.project_id,
      new.id,
      'residence',
      'Місце проживання',
      new.residence_places,
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      jsonb_build_object('source', 'persons_projection')
    );
  end if;

  return new;
end;
$$;

create or replace function public.family_tree_sync_legacy_relation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_tree_id uuid;
  target_family_group_id uuid;
  target_parent_set_id uuid;
  target_edge_id uuid;
  edge_parent_id uuid;
  edge_child_id uuid;
  edge_person_a_id uuid;
  edge_person_b_id uuid;
  relationship_kind text;
  parent_relationship_type text;
  parent_set_type text;
  parent_role_label text;
  partner_relationship_type text;
  edge_association_type text;
  association_direction text;
  evidence_status text;
  confidence integer;
  is_bloodline boolean;
  is_legal boolean;
  is_social boolean;
  should_be_default boolean;
  actor_id uuid;
  edge_metadata jsonb;
begin
  if tg_op = 'DELETE' then
    perform public.family_tree_remove_legacy_relation_edges(old.id);
    return old;
  end if;

  perform public.family_tree_remove_legacy_relation_edges(new.id);

  if new.person_id = new.related_person_id then
    return new;
  end if;

  actor_id := coalesce(new.created_by, auth.uid());
  if actor_id is null then
    select owner_id
      into actor_id
    from public.projects
    where id = new.project_id;
  end if;

  if actor_id is null then
    return new;
  end if;

  target_tree_id := public.family_tree_default_for_project(new.project_id, actor_id);
  evidence_status := public.family_tree_evidence_status_from_legacy(new.status);
  confidence := public.family_tree_confidence_for_evidence(evidence_status);
  edge_metadata := jsonb_build_object(
    'source',
    'person_relations',
    'legacyRelationId',
    new.id,
    'legacyRelationType',
    new.relation_type
  );

  perform public.family_tree_member_ensure(new.project_id, target_tree_id, new.person_id);
  perform public.family_tree_member_ensure(new.project_id, target_tree_id, new.related_person_id);

  if new.relation_type in ('батько', 'мати', 'батько або мати', 'вітчим', 'мачуха', 'опікун', 'усиновлювач') then
    relationship_kind := 'parent_child';
    edge_parent_id := new.related_person_id;
    edge_child_id := new.person_id;
  elsif new.relation_type in ('дитина', 'син', 'донька', 'пасинок', 'падчерка', 'підопічний', 'усиновлена дитина') then
    relationship_kind := 'parent_child';
    edge_parent_id := new.person_id;
    edge_child_id := new.related_person_id;
  elsif new.relation_type in ('чоловік', 'дружина', 'подружжя') then
    relationship_kind := 'partner';
  elsif new.relation_type in (
    'хрещений',
    'хрещена',
    'хрещеник',
    'хрещениця',
    'свідок',
    'поручитель',
    'священник',
    'духовна особа',
    'посадова особа',
    'повитуха',
    'особа, яка повідомила',
    'голова господарства',
    'член господарства',
    'наймит або служник',
    'брат',
    'сестра',
    'брат або сестра',
    'родич',
    'інше'
  ) then
    relationship_kind := 'association';
  else
    return new;
  end if;

  if relationship_kind = 'parent_child' then
    parent_relationship_type := case new.relation_type
      when 'батько' then 'biological'
      when 'мати' then 'biological'
      when 'батько або мати' then 'presumed'
      when 'дитина' then 'biological'
      when 'син' then 'biological'
      when 'донька' then 'biological'
      when 'вітчим' then 'step'
      when 'мачуха' then 'step'
      when 'пасинок' then 'step'
      when 'падчерка' then 'step'
      when 'опікун' then 'guardian'
      when 'підопічний' then 'guardian'
      when 'усиновлювач' then 'adoptive'
      when 'усиновлена дитина' then 'adoptive'
      else 'unknown'
    end;
    parent_set_type := case parent_relationship_type
      when 'biological' then 'biological'
      when 'adoptive' then 'adoptive'
      when 'step' then 'step'
      when 'guardian' then 'guardian'
      when 'presumed' then 'unknown'
      else 'unknown'
    end;
    parent_role_label := case new.relation_type
      when 'батько' then 'father'
      when 'мати' then 'mother'
      when 'вітчим' then 'stepfather'
      when 'мачуха' then 'stepmother'
      when 'опікун' then 'guardian'
      else 'parent'
    end;
    is_bloodline := parent_relationship_type in ('biological', 'genetic_father', 'genetic_mother', 'birth_parent', 'presumed');
    is_legal := parent_relationship_type in ('adoptive', 'guardian', 'legal_parent');
    is_social := parent_relationship_type in ('step', 'foster', 'guardian', 'social_parent', 'adoptive');

    select id
      into target_parent_set_id
    from public.parent_sets ps
    where ps.project_id = new.project_id
      and ps.tree_id = target_tree_id
      and ps.child_id = edge_child_id
      and set_type = parent_set_type
    order by is_default_for_pedigree desc, is_preferred_for_display desc, created_at
    limit 1;

    if target_parent_set_id is null then
      should_be_default := not exists (
        select 1
        from public.parent_sets
        where tree_id = target_tree_id
          and child_id = edge_child_id
          and is_default_for_pedigree
      );

      insert into public.parent_sets (
        project_id,
        tree_id,
        child_id,
        set_type,
        is_preferred_for_display,
        is_default_for_pedigree,
        metadata,
        created_by
      )
      values (
        new.project_id,
        target_tree_id,
        edge_child_id,
        parent_set_type,
        should_be_default,
        should_be_default,
        jsonb_build_object('source', 'person_relations'),
        actor_id
      )
      returning id into target_parent_set_id;
    end if;

    select id
      into target_edge_id
    from public.parent_child_relationships pcr
    where pcr.tree_id = target_tree_id
      and pcr.parent_id = edge_parent_id
      and pcr.child_id = edge_child_id
      and relationship_type = parent_relationship_type
      and parent_set_id = target_parent_set_id
    limit 1;

    if target_edge_id is null then
      insert into public.parent_child_relationships (
        project_id,
        tree_id,
        parent_id,
        child_id,
        parent_set_id,
        relationship_type,
        parent_role_label,
        evidence_status,
        confidence,
        is_primary_for_display,
        is_bloodline,
        is_legal,
        is_social,
        notes,
        metadata,
        created_by
      )
      values (
        new.project_id,
        target_tree_id,
        edge_parent_id,
        edge_child_id,
        target_parent_set_id,
        parent_relationship_type,
        parent_role_label,
        evidence_status,
        confidence,
        false,
        is_bloodline,
        is_legal,
        is_social,
        concat_ws(E'\n\n', nullif(new.evidence_text, ''), nullif(new.notes, '')),
        edge_metadata,
        actor_id
      )
      returning id into target_edge_id;
    end if;

    insert into public.legacy_person_relation_graph_edges (
      project_id,
      relation_id,
      tree_id,
      edge_kind,
      edge_id
    )
    values (
      new.project_id,
      new.id,
      target_tree_id,
      'parent_child',
      target_edge_id
    )
    on conflict do nothing;

    return new;
  end if;

  if relationship_kind = 'partner' then
    partner_relationship_type := 'marriage';
    edge_person_a_id := least(new.person_id, new.related_person_id);
    edge_person_b_id := greatest(new.person_id, new.related_person_id);

    select id
      into target_family_group_id
    from public.family_groups fg
    where fg.tree_id = target_tree_id
      and group_type = 'couple'
      and least(fg.primary_partner_1_id, fg.primary_partner_2_id) = edge_person_a_id
      and greatest(fg.primary_partner_1_id, fg.primary_partner_2_id) = edge_person_b_id
    limit 1;

    if target_family_group_id is null then
      insert into public.family_groups (
        project_id,
        tree_id,
        group_type,
        display_label,
        primary_partner_1_id,
        primary_partner_2_id,
        metadata,
        created_by
      )
      values (
        new.project_id,
        target_tree_id,
        'couple',
        '',
        edge_person_a_id,
        edge_person_b_id,
        jsonb_build_object('source', 'person_relations'),
        actor_id
      )
      returning id into target_family_group_id;
    end if;

    insert into public.family_group_members (
      project_id,
      family_group_id,
      person_id,
      member_role
    )
    values
      (new.project_id, target_family_group_id, edge_person_a_id, 'partner'),
      (new.project_id, target_family_group_id, edge_person_b_id, 'partner')
    on conflict do nothing;

    select id
      into target_edge_id
    from public.partner_relationships pr
    where pr.tree_id = target_tree_id
      and least(pr.person_a_id, pr.person_b_id) = edge_person_a_id
      and greatest(pr.person_a_id, pr.person_b_id) = edge_person_b_id
      and relationship_type = partner_relationship_type
      and family_group_id = target_family_group_id
    limit 1;

    if target_edge_id is null then
      insert into public.partner_relationships (
        project_id,
        tree_id,
        family_group_id,
        person_a_id,
        person_b_id,
        relationship_type,
        status,
        evidence_status,
        confidence,
        is_primary_for_display,
        notes,
        metadata,
        created_by
      )
      values (
        new.project_id,
        target_tree_id,
        target_family_group_id,
        edge_person_a_id,
        edge_person_b_id,
        partner_relationship_type,
        'unknown',
        evidence_status,
        confidence,
        false,
        concat_ws(E'\n\n', nullif(new.evidence_text, ''), nullif(new.notes, '')),
        edge_metadata,
        actor_id
      )
      returning id into target_edge_id;
    end if;

    insert into public.legacy_person_relation_graph_edges (
      project_id,
      relation_id,
      tree_id,
      edge_kind,
      edge_id
    )
    values (
      new.project_id,
      new.id,
      target_tree_id,
      'partner',
      target_edge_id
    )
    on conflict do nothing;

    return new;
  end if;

  if relationship_kind = 'association' then
    edge_association_type := case new.relation_type
      when 'хрещений' then 'godparent'
      when 'хрещена' then 'godparent'
      when 'хрещеник' then 'godparent'
      when 'хрещениця' then 'godparent'
      when 'свідок' then 'witness'
      when 'поручитель' then 'witness'
      when 'священник' then 'clergy'
      when 'духовна особа' then 'clergy'
      when 'посадова особа' then 'official'
      when 'повитуха' then 'official'
      when 'особа, яка повідомила' then 'official'
      when 'голова господарства' then 'household_member'
      when 'член господарства' then 'household_member'
      when 'наймит або служник' then 'household_member'
      when 'брат' then 'possible_relative'
      when 'сестра' then 'possible_relative'
      when 'брат або сестра' then 'possible_relative'
      when 'родич' then 'possible_relative'
      else 'other'
    end;
    association_direction := case new.relation_type
      when 'хрещений' then 'related_to_person'
      when 'хрещена' then 'related_to_person'
      when 'свідок' then 'related_to_person'
      when 'поручитель' then 'related_to_person'
      when 'священник' then 'related_to_person'
      when 'духовна особа' then 'related_to_person'
      when 'посадова особа' then 'related_to_person'
      when 'повитуха' then 'related_to_person'
      when 'особа, яка повідомила' then 'related_to_person'
      when 'голова господарства' then 'related_to_person'
      else 'person_to_related'
    end;

    if association_direction = 'related_to_person' then
      edge_person_a_id := new.related_person_id;
      edge_person_b_id := new.person_id;
    else
      edge_person_a_id := new.person_id;
      edge_person_b_id := new.related_person_id;
    end if;

    select id
      into target_edge_id
    from public.association_relationships ar
    where ar.tree_id = target_tree_id
      and ar.person_a_id = edge_person_a_id
      and ar.person_b_id = edge_person_b_id
      and ar.association_type = edge_association_type
    limit 1;

    if target_edge_id is null then
      insert into public.association_relationships (
        project_id,
        tree_id,
        person_a_id,
        person_b_id,
        association_type,
        person_a_role_label,
        person_b_role_label,
        evidence_status,
        confidence,
        notes,
        metadata,
        created_by
      )
      values (
        new.project_id,
        target_tree_id,
        edge_person_a_id,
        edge_person_b_id,
        edge_association_type,
        new.relation_type,
        '',
        evidence_status,
        confidence,
        concat_ws(E'\n\n', nullif(new.evidence_text, ''), nullif(new.notes, '')),
        edge_metadata,
        actor_id
      )
      returning id into target_edge_id;
    end if;

    insert into public.legacy_person_relation_graph_edges (
      project_id,
      relation_id,
      tree_id,
      edge_kind,
      edge_id
    )
    values (
      new.project_id,
      new.id,
      target_tree_id,
      'association',
      target_edge_id
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists persons_family_tree_projection_sync on public.persons;
create trigger persons_family_tree_projection_sync
after insert or update of
  status,
  surname,
  given_name,
  patronymic,
  full_name,
  birth_date,
  birth_year_from,
  birth_year_to,
  birth_place,
  marriage_date,
  marriage_place,
  death_date,
  death_year_from,
  death_year_to,
  death_place,
  residence_places
on public.persons
for each row
execute function public.family_tree_sync_person_projection();

drop trigger if exists person_relations_family_graph_sync on public.person_relations;
create trigger person_relations_family_graph_sync
after insert or update of person_id, related_person_id, relation_type, status, evidence_text, notes
on public.person_relations
for each row
execute function public.family_tree_sync_legacy_relation();

drop trigger if exists person_relations_family_graph_delete_sync on public.person_relations;
create trigger person_relations_family_graph_delete_sync
after delete
on public.person_relations
for each row
execute function public.family_tree_sync_legacy_relation();

-- Backfill existing data once so the future tree graph is available without
-- requiring users to manually reopen and save old records.
update public.persons
set full_name = full_name;

update public.person_relations
set relation_type = relation_type;

alter table public.legacy_person_relation_graph_edges enable row level security;

drop policy if exists legacy_person_relation_graph_edges_select_members
  on public.legacy_person_relation_graph_edges;
create policy legacy_person_relation_graph_edges_select_members
  on public.legacy_person_relation_graph_edges
  for select to authenticated
  using ((select public.is_project_member(project_id)));

grant select on public.legacy_person_relation_graph_edges to authenticated;

revoke execute on function public.family_tree_evidence_status_from_legacy(text) from public, anon;
revoke execute on function public.family_tree_confidence_for_evidence(text) from public, anon;
revoke execute on function public.family_tree_default_for_project(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.family_tree_member_ensure(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.family_tree_remove_legacy_relation_edges(uuid) from public, anon, authenticated;
revoke execute on function public.family_tree_sync_person_projection() from public, anon, authenticated;
revoke execute on function public.family_tree_sync_legacy_relation() from public, anon, authenticated;

commit;
