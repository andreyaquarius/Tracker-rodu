begin;

create table if not exists public.person_names (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  person_id uuid not null,
  name_type text not null default 'primary'
    check (name_type in (
      'primary',
      'birth',
      'married',
      'alias',
      'original',
      'transliteration',
      'religious',
      'patronymic_variant',
      'surname_variant',
      'other'
    )),
  language_code text not null default 'uk',
  script_code text not null default 'Cyrl',
  surname text not null default '',
  given_name text not null default '',
  patronymic text not null default '',
  full_name text not null default '',
  original_text text not null default '',
  is_primary boolean not null default false,
  is_preferred boolean not null default false,
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 50 check (confidence between 0 and 100),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, project_id)
    references public.persons(id, project_id)
    on delete cascade
);

create unique index if not exists person_names_one_primary_per_person_uq
  on public.person_names (person_id)
  where is_primary;
create index if not exists person_names_project_person_idx
  on public.person_names (project_id, person_id, is_primary desc, is_preferred desc);
create index if not exists person_names_lookup_idx
  on public.person_names (project_id, lower(full_name), lower(surname), lower(given_name));
create index if not exists person_names_source_document_idx
  on public.person_names (source_document_id)
  where source_document_id is not null;
create index if not exists person_names_source_finding_idx
  on public.person_names (source_finding_id)
  where source_finding_id is not null;

create table if not exists public.person_timeline_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  person_id uuid not null,
  event_type text not null default 'other'
    check (event_type in (
      'birth',
      'baptism',
      'christening',
      'marriage',
      'divorce',
      'residence',
      'census',
      'revision_list',
      'confession_list',
      'immigration',
      'emigration',
      'military',
      'occupation',
      'death',
      'burial',
      'cremation',
      'probate',
      'mention',
      'other'
    )),
  title text not null default '',
  event_date text not null default '',
  date_from text not null default '',
  date_to text not null default '',
  date_text text not null default '',
  place_name text not null default '',
  geo jsonb,
  event_role text not null default 'subject',
  evidence_status text not null default 'unknown'
    check (evidence_status in ('proven', 'likely', 'disputed', 'disproven', 'unknown')),
  confidence integer not null default 50 check (confidence between 0 and 100),
  source_document_id uuid references public.documents(id) on delete set null,
  source_finding_id uuid references public.findings(id) on delete set null,
  notes text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (person_id, project_id)
    references public.persons(id, project_id)
    on delete cascade
);

create index if not exists person_timeline_events_project_person_idx
  on public.person_timeline_events (project_id, person_id, event_type);
create index if not exists person_timeline_events_project_type_idx
  on public.person_timeline_events (project_id, event_type);
create index if not exists person_timeline_events_date_idx
  on public.person_timeline_events (project_id, event_date)
  where event_date <> '';
create index if not exists person_timeline_events_source_document_idx
  on public.person_timeline_events (source_document_id)
  where source_document_id is not null;
create index if not exists person_timeline_events_source_finding_idx
  on public.person_timeline_events (source_finding_id)
  where source_finding_id is not null;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'person_names',
    'person_timeline_events'
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

grant select, insert, update, delete on
  public.person_names,
  public.person_timeline_events
to authenticated;

commit;
