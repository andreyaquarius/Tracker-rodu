begin;

create extension if not exists pgcrypto;

create type public.project_role as enum ('owner', 'editor', 'viewer');
create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_unique on public.profiles (lower(email));

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(user_id),
  name text not null,
  description text not null default '',
  project_type text not null default 'genealogy',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role public.project_role not null,
  invited_by uuid references public.profiles(user_id),
  joined_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_id_idx on public.project_members (user_id);

create table public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  email text not null,
  role public.project_role not null check (role <> 'owner'),
  status public.invitation_status not null default 'pending',
  invited_by uuid not null references public.profiles(user_id),
  accepted_by uuid references public.profiles(user_id),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);

create unique index project_invitations_pending_unique
  on public.project_invitations (project_id, lower(email))
  where status = 'pending';

create table public.researches (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  goal text not null default '',
  surnames text not null default '',
  places text not null default '',
  period_from text not null default '',
  period_to text not null default '',
  archives text not null default '',
  status text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  status text not null default '',
  gender text not null default '',
  surname text not null default '',
  given_name text not null default '',
  patronymic text not null default '',
  full_name text not null default '',
  name_variants text not null default '',
  surname_variants text not null default '',
  birth_date text not null default '',
  birth_year_from text not null default '',
  birth_year_to text not null default '',
  birth_place text not null default '',
  marriage_date text not null default '',
  marriage_place text not null default '',
  death_date text not null default '',
  death_year_from text not null default '',
  death_year_to text not null default '',
  death_place text not null default '',
  residence_places text not null default '',
  social_status text not null default '',
  religion text not null default '',
  occupation text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.person_relations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  related_person_id uuid not null references public.persons(id) on delete cascade,
  relation_type text not null,
  status text not null default '',
  evidence_text text not null default '',
  notes text not null default '',
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (person_id <> related_person_id)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  title text not null,
  document_type text not null default '',
  archive text not null default '',
  fund text not null default '',
  file_reference text not null default '',
  year_from text not null default '',
  year_to text not null default '',
  place text not null default '',
  url text not null default '',
  pages_count text not null default '',
  last_page text not null default '',
  review_status text not null default '',
  description text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.year_matrix (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  year_text text not null,
  place text not null default '',
  document_type text not null default '',
  status text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  person_name text not null default '',
  title text not null,
  description text not null default '',
  place text not null default '',
  year_from text not null default '',
  year_to text not null default '',
  document_type text not null default '',
  document_id uuid references public.documents(id) on delete set null,
  status text not null default '',
  priority text not null default '',
  deadline text not null default '',
  notes text not null default '',
  completed_at timestamptz,
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_persons (
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  primary key (task_id, person_id)
);

create table public.findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  finding_type text not null default '',
  event_date text not null default '',
  people text not null default '',
  persons_text text not null default '',
  place text not null default '',
  archive text not null default '',
  fund text not null default '',
  description text not null default '',
  file_reference text not null default '',
  page text not null default '',
  summary text not null default '',
  transcription text not null default '',
  conclusion text not null default '',
  reliability text not null default '',
  needs_review boolean not null default false,
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.finding_participants (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  finding_id uuid not null references public.findings(id) on delete cascade,
  person_id uuid references public.persons(id) on delete set null,
  name text not null default '',
  role text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table public.hypotheses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  title text not null,
  description text not null default '',
  to_verify text not null default '',
  related_people text not null default '',
  status text not null default '',
  probability text not null default '',
  arguments_for text not null default '',
  arguments_against text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.hypothesis_links (
  project_id uuid not null references public.projects(id) on delete cascade,
  hypothesis_id uuid not null references public.hypotheses(id) on delete cascade,
  target_type text not null check (target_type in ('person', 'document', 'finding')),
  target_id uuid not null,
  primary key (hypothesis_id, target_type, target_id)
);

create table public.archive_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  research_id uuid references public.researches(id) on delete set null,
  archive text not null default '',
  archive_details text not null default '',
  request_date text not null default '',
  response_date text not null default '',
  status text not null default '',
  subject text not null default '',
  notes text not null default '',
  custom_fields jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.archive_request_persons (
  project_id uuid not null references public.projects(id) on delete cascade,
  archive_request_id uuid not null references public.archive_requests(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  primary key (archive_request_id, person_id)
);

create table public.custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  module_key text not null,
  label text not null,
  field_type text not null,
  options jsonb not null default '[]'::jsonb,
  relation_target text,
  required boolean not null default false,
  position integer not null default 0,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.custom_sections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  singular_name text not null,
  description text not null default '',
  icon text not null default '',
  title_field_id uuid,
  position integer not null default 0,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.custom_section_fields (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  section_id uuid not null references public.custom_sections(id) on delete cascade,
  label text not null,
  field_type text not null,
  options jsonb not null default '[]'::jsonb,
  relation_target text,
  required boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.custom_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  section_id uuid not null references public.custom_sections(id) on delete cascade,
  title text not null,
  values jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.record_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_type text not null,
  source_id uuid not null,
  field_id uuid,
  target_type text not null,
  target_id uuid not null,
  created_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now()
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_type text not null,
  owner_id uuid not null,
  field_key text not null default '',
  storage_bucket text not null default 'project-attachments',
  storage_path text not null,
  file_name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  uploaded_by uuid not null default auth.uid() references public.profiles(user_id),
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create table public.activity_log (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index researches_project_idx on public.researches (project_id);
create index persons_project_idx on public.persons (project_id);
create index persons_research_idx on public.persons (research_id);
create index documents_project_idx on public.documents (project_id);
create index documents_research_idx on public.documents (research_id);
create index year_matrix_project_idx on public.year_matrix (project_id);
create index tasks_project_idx on public.tasks (project_id);
create index findings_project_idx on public.findings (project_id);
create index hypotheses_project_idx on public.hypotheses (project_id);
create index archive_requests_project_idx on public.archive_requests (project_id);
create index custom_records_project_section_idx on public.custom_records (project_id, section_id);
create index attachments_project_owner_idx on public.attachments (project_id, owner_type, owner_id);
create index activity_log_project_created_idx on public.activity_log (project_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles', 'projects', 'researches', 'persons', 'person_relations',
    'documents', 'year_matrix', 'tasks', 'findings', 'hypotheses',
    'archive_requests', 'custom_field_definitions', 'custom_sections',
    'custom_section_fields', 'custom_records'
  ]
  loop
    execute format(
      'create trigger %I_set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture', '')
  )
  on conflict (user_id) do update
  set email = excluded.email,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      updated_at = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.add_project_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (project_id, user_id) do update set role = 'owner';
  return new;
end;
$$;

create trigger on_project_created
  after insert on public.projects
  for each row execute function public.add_project_owner();

create or replace function public.is_project_member(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = target_project_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members
    where project_id = target_project_id
      and user_id = auth.uid()
      and role in ('owner', 'editor')
  );
$$;

create or replace function public.is_project_owner(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.projects
    where id = target_project_id
      and owner_id = auth.uid()
  );
$$;

grant execute on function public.is_project_member(uuid) to authenticated;
grant execute on function public.can_edit_project(uuid) to authenticated;
grant execute on function public.is_project_owner(uuid) to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.add_project_owner() from public, anon, authenticated;
revoke execute on function public.is_project_member(uuid) from public, anon;
revoke execute on function public.can_edit_project(uuid) from public, anon;
revoke execute on function public.is_project_owner(uuid) from public, anon;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.project_invitations enable row level security;

create policy profiles_select_related
on public.profiles for select to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = auth.uid()
      and theirs.user_id = profiles.user_id
  )
);

create policy profiles_update_self
on public.profiles for update to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy projects_select_members
on public.projects for select to authenticated
using (public.is_project_member(id));

create policy projects_insert_owner
on public.projects for insert to authenticated
with check (owner_id = auth.uid());

create policy projects_update_owner
on public.projects for update to authenticated
using (public.is_project_owner(id))
with check (owner_id = auth.uid());

create policy projects_delete_owner
on public.projects for delete to authenticated
using (public.is_project_owner(id));

create policy project_members_select_members
on public.project_members for select to authenticated
using (public.is_project_member(project_id));

create policy project_members_insert_owner
on public.project_members for insert to authenticated
with check (
  public.is_project_owner(project_id)
  and role <> 'owner'
);

create policy project_members_update_owner
on public.project_members for update to authenticated
using (
  public.is_project_owner(project_id)
  and user_id <> auth.uid()
)
with check (
  public.is_project_owner(project_id)
  and role <> 'owner'
);

create policy project_members_delete_owner
on public.project_members for delete to authenticated
using (
  public.is_project_owner(project_id)
  and user_id <> auth.uid()
);

create policy invitations_select_owner_or_recipient
on public.project_invitations for select to authenticated
using (
  public.is_project_owner(project_id)
  or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);

create policy invitations_manage_owner
on public.project_invitations for all to authenticated
using (public.is_project_owner(project_id))
with check (public.is_project_owner(project_id));

create or replace function public.accept_project_invitation(invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.project_invitations%rowtype;
  current_email text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  current_email := lower(coalesce(auth.jwt() ->> 'email', ''));

  select *
  into invitation
  from public.project_invitations
  where id = invitation_id
  for update;

  if not found
     or invitation.status <> 'pending'
     or invitation.expires_at <= now()
     or lower(invitation.email) <> current_email then
    raise exception 'Invitation is invalid or expired';
  end if;

  if exists (
    select 1
    from public.projects
    where id = invitation.project_id
      and owner_id = auth.uid()
  ) then
    raise exception 'Project owner cannot accept a lower role';
  end if;

  insert into public.project_members (project_id, user_id, role, invited_by)
  values (invitation.project_id, auth.uid(), invitation.role, invitation.invited_by)
  on conflict (project_id, user_id)
  do update set role = excluded.role, invited_by = excluded.invited_by;

  update public.project_invitations
  set status = 'accepted',
      accepted_by = auth.uid(),
      accepted_at = now()
  where id = invitation.id;

  return invitation.project_id;
end;
$$;

grant execute on function public.accept_project_invitation(uuid) to authenticated;
revoke execute on function public.accept_project_invitation(uuid) from public, anon;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'researches', 'persons', 'person_relations', 'documents', 'year_matrix',
    'tasks', 'task_persons', 'findings', 'finding_participants', 'hypotheses',
    'hypothesis_links', 'archive_requests', 'archive_request_persons',
    'custom_records', 'record_links', 'attachments'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I_select on public.%I for select to authenticated
       using (public.is_project_member(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated
       with check (public.can_edit_project(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_update on public.%I for update to authenticated
       using (public.can_edit_project(project_id))
       with check (public.can_edit_project(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated
       using (public.can_edit_project(project_id))',
      table_name,
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
    'custom_field_definitions', 'custom_sections', 'custom_section_fields'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I_select on public.%I for select to authenticated
       using (public.is_project_member(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated
       with check (public.is_project_owner(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_update on public.%I for update to authenticated
       using (public.is_project_owner(project_id))
       with check (public.is_project_owner(project_id))',
      table_name,
      table_name
    );
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated
       using (public.is_project_owner(project_id))',
      table_name,
      table_name
    );
  end loop;
end;
$$;

alter table public.activity_log enable row level security;

create policy activity_log_select_members
on public.activity_log for select to authenticated
using (public.is_project_member(project_id));

create policy activity_log_insert_editors
on public.activity_log for insert to authenticated
with check (
  public.can_edit_project(project_id)
  and actor_id = auth.uid()
);

grant usage on schema public to authenticated;
grant usage on type public.project_role, public.invitation_status to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

commit;
