begin;

-- Tags reference an existing owner/field attachment, never a preview URL.
create unique index attachments_id_project_photo_tag_uq on public.attachments(id, project_id);

create table public.photo_person_tags (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  attachment_id uuid not null,
  person_id uuid not null,
  x numeric not null, y numeric not null,
  width numeric not null, height numeric not null,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (attachment_id, project_id) references public.attachments(id, project_id) on delete cascade,
  foreign key (person_id, project_id) references public.persons(id, project_id) on delete cascade,
  check (x >= 0 and y >= 0 and width > 0 and height > 0
    and x < 1 and y < 1 and width <= 1 and height <= 1
    and x + width <= 1 and y + height <= 1),
  unique (attachment_id, person_id)
);
create index photo_person_tags_person_idx on public.photo_person_tags(project_id, person_id, id);
create index photo_person_tags_attachment_idx on public.photo_person_tags(project_id, attachment_id, id);

-- Invoker functions retain RLS on the original owner and attachment. Reject
-- stale metadata: the Drive identity must still occur in that owner's JSON.
-- Private/confidential people follow the project's editor boundary.
create function public.photo_tag_person_visible_v1(p_project_id uuid, p_person_id uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select public.is_project_member(p_project_id) and exists (
    select 1 from public.persons p where p.id = p_person_id and p.project_id = p_project_id
      and (p.privacy_status not in ('private', 'confidential') or public.can_edit_project(p_project_id))
  );
$$;

create function public.photo_tag_source_v1(p_project_id uuid, p_attachment_id uuid)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare a public.attachments; owner_data jsonb; source_scan jsonb;
begin
  if not public.is_project_member(p_project_id) then return null; end if;
  select * into a from public.attachments
    where id = p_attachment_id and project_id = p_project_id
      and storage_bucket = 'google-drive' and storage_path <> '' and mime_type like 'image/%';
  if not found then return null; end if;
  case a.owner_type
    when 'persons' then
      if not public.photo_tag_person_visible_v1(p_project_id, a.owner_id) then return null; end if;
      select custom_fields into owner_data from public.persons where id = a.owner_id and project_id = p_project_id;
    when 'documents' then
      select custom_fields into owner_data from public.documents where id = a.owner_id and project_id = p_project_id;
    when 'findings' then
      select custom_fields into owner_data from public.findings where id = a.owner_id and project_id = p_project_id;
    else return null;
  end case;
  select value into source_scan from jsonb_path_query(owner_data,
    '$.** ? (@.id == $id && @.storagePath == $path && @.storage == "google-drive")',
    jsonb_build_object('id', a.id::text, 'path', a.storage_path)) as scans(value) limit 1;
  if source_scan is null then return null; end if;
  return jsonb_build_object('id', a.id, 'name', a.file_name, 'mimeType', a.mime_type,
    'size', a.size_bytes, 'createdAt', a.created_at, 'storage', 'google-drive',
    'storagePath', a.storage_path, 'driveResourceKey', source_scan->>'driveResourceKey');
end;
$$;

alter table public.photo_person_tags enable row level security;
create policy photo_tags_read on public.photo_person_tags for select to authenticated using (
  public.photo_tag_person_visible_v1(project_id, person_id)
  and public.photo_tag_source_v1(project_id, attachment_id) is not null
);
create policy photo_tags_insert on public.photo_person_tags for insert to authenticated with check (
  public.can_edit_project(project_id)
  and public.photo_tag_person_visible_v1(project_id, person_id)
  and public.photo_tag_source_v1(project_id, attachment_id) is not null
);
create policy photo_tags_update on public.photo_person_tags for update to authenticated using (
  public.can_edit_project(project_id) and public.photo_tag_source_v1(project_id, attachment_id) is not null
) with check (
  public.can_edit_project(project_id)
  and public.photo_tag_person_visible_v1(project_id, person_id)
  and public.photo_tag_source_v1(project_id, attachment_id) is not null
);
create policy photo_tags_delete on public.photo_person_tags for delete to authenticated using (
  public.can_edit_project(project_id) and public.photo_tag_source_v1(project_id, attachment_id) is not null
);
grant select, insert, update, delete on public.photo_person_tags to authenticated;
revoke all on public.photo_person_tags from anon;

create function public.guard_photo_person_tag_v1() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.project_id <> old.project_id or new.attachment_id <> old.attachment_id then
    raise exception 'PHOTO_TAG_SOURCE_IMMUTABLE' using errcode = '23514';
  end if;
  new.version := old.version + 1;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;
create trigger guard_photo_person_tag before update on public.photo_person_tags
for each row execute function public.guard_photo_person_tag_v1();

-- Replacing the original file or moving the association invalidates rectangles.
-- This private trigger must also clean up tags hidden by a changed owner.
create function security_private.clear_replaced_photo_tags_v1() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (new.storage_bucket, new.storage_path, new.owner_type, new.owner_id, new.field_key, new.project_id)
    is distinct from (old.storage_bucket, old.storage_path, old.owner_type, old.owner_id, old.field_key, old.project_id) then
    delete from public.photo_person_tags where attachment_id = old.id;
  end if;
  return new;
end;
$$;
create trigger clear_replaced_photo_tags before update on public.attachments
for each row execute function security_private.clear_replaced_photo_tags_v1();

create function public.list_photo_person_tags_v1(p_project_id uuid, p_attachment_id uuid default null, p_person_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare source jsonb; result jsonb;
begin
  if (p_attachment_id is null) = (p_person_id is null) then
    raise exception 'PHOTO_TAG_FILTER_REQUIRED' using errcode = '22023';
  end if;
  if p_attachment_id is not null then
    source := public.photo_tag_source_v1(p_project_id, p_attachment_id);
    if source is null then raise exception 'PHOTO_TAG_SOURCE_UNAVAILABLE' using errcode = '42501'; end if;
  elsif not public.photo_tag_person_visible_v1(p_project_id, p_person_id) then
    raise exception 'PHOTO_TAG_PERSON_UNAVAILABLE' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'personId', t.person_id, 'personName', coalesce(nullif(p.full_name, ''),
      nullif(concat_ws(' ', nullif(p.surname, ''), nullif(p.given_name, ''), nullif(p.patronymic, '')), ''), 'Без імені'),
    'attachmentId', t.attachment_id, 'x', t.x, 'y', t.y, 'width', t.width, 'height', t.height,
    'version', t.version, 'photo', coalesce(source, public.photo_tag_source_v1(p_project_id, t.attachment_id))
  ) order by t.created_at, t.id), '[]'::jsonb) into result
  from public.photo_person_tags t join public.persons p on p.id = t.person_id and p.project_id = t.project_id
  where t.project_id = p_project_id
    and (p_attachment_id is null or t.attachment_id = p_attachment_id)
    and (p_person_id is null or t.person_id = p_person_id);
  return jsonb_build_object('photo', source, 'canEdit', public.can_edit_project(p_project_id), 'tags', result);
end;
$$;

create function public.search_photo_tag_persons_v1(p_project_id uuid, p_query text)
returns table(id uuid, name text, detail text) language sql stable security invoker set search_path = '' as $$
  select p.id, coalesce(nullif(p.full_name, ''), nullif(concat_ws(' ', nullif(p.surname, ''),
    nullif(p.given_name, ''), nullif(p.patronymic, '')), ''), 'Без імені'),
    concat_ws(' · ', nullif(p.birth_date, ''), nullif(p.birth_place, ''))
  from public.persons p where p.project_id = p_project_id
    and public.photo_tag_person_visible_v1(p_project_id, p.id)
    and length(btrim(p_query)) >= 2
    and strpos(lower(concat_ws(' ', p.full_name, p.surname, p.given_name, p.patronymic, p.name_variants, p.surname_variants)), lower(btrim(left(p_query, 160)))) > 0
  order by p.full_name, p.id limit 30;
$$;

create function public.save_photo_person_tag_v1(p_project_id uuid, p_attachment_id uuid, p_person_id uuid,
  p_x numeric, p_y numeric, p_width numeric, p_height numeric, p_id uuid default null, p_version integer default null)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare saved_id uuid;
begin
  if p_id is null then
    insert into public.photo_person_tags(project_id, attachment_id, person_id, x, y, width, height)
      values (p_project_id, p_attachment_id, p_person_id, p_x, p_y, p_width, p_height) returning id into saved_id;
  else
    update public.photo_person_tags set person_id = p_person_id, x = p_x, y = p_y, width = p_width, height = p_height
      where id = p_id and project_id = p_project_id and attachment_id = p_attachment_id and version = p_version
      returning id into saved_id;
    if saved_id is null then raise exception 'PHOTO_TAG_STALE_OR_FORBIDDEN' using errcode = '40001'; end if;
  end if;
  return saved_id;
end;
$$;
create function public.delete_photo_person_tag_v1(p_project_id uuid, p_id uuid, p_version integer)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.photo_person_tags where id = p_id and project_id = p_project_id and version = p_version;
  if not found then raise exception 'PHOTO_TAG_STALE_OR_FORBIDDEN' using errcode = '40001'; end if;
end;
$$;

revoke all on function security_private.clear_replaced_photo_tags_v1() from public, anon, authenticated;
revoke all on function public.guard_photo_person_tag_v1() from public, anon, authenticated;
revoke all on function public.photo_tag_person_visible_v1(uuid, uuid), public.photo_tag_source_v1(uuid, uuid),
  public.list_photo_person_tags_v1(uuid, uuid, uuid), public.search_photo_tag_persons_v1(uuid, text),
  public.save_photo_person_tag_v1(uuid, uuid, uuid, numeric, numeric, numeric, numeric, uuid, integer),
  public.delete_photo_person_tag_v1(uuid, uuid, integer) from public, anon;
grant execute on function public.photo_tag_person_visible_v1(uuid, uuid), public.photo_tag_source_v1(uuid, uuid),
  public.list_photo_person_tags_v1(uuid, uuid, uuid), public.search_photo_tag_persons_v1(uuid, text),
  public.save_photo_person_tag_v1(uuid, uuid, uuid, numeric, numeric, numeric, numeric, uuid, integer),
  public.delete_photo_person_tag_v1(uuid, uuid, integer) to authenticated;
-- Preserve the existing bounded project-deletion order, adding tags first.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array[
    'photo_person_tags',
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

notify pgrst, 'reload schema';
commit;
