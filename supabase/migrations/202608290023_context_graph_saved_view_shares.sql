begin;

-- Anonymous, read-only share links for personal Research Graph saved views
-- (TZ 13, section 25).  This first public contract is deliberately narrow:
-- only the project owner may publish their own saved view, only one current
-- bearer token exists per view, and every resolve re-evaluates current privacy.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

create unique index if not exists context_graph_saved_views_identity_uidx
  on security_private.context_graph_saved_views (id, project_id, owner_id);

create table if not exists security_private.context_graph_saved_view_shares (
  id uuid primary key default gen_random_uuid(),
  view_id uuid not null unique,
  project_id uuid not null,
  owner_id uuid not null,
  access_mode text not null default 'public_readonly',
  public_title text not null default 'Спільний дослідницький граф',
  token_hash bytea not null unique,
  source_view_lock_version integer not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  lock_version integer not null default 1,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint context_graph_saved_view_shares_view_fk
    foreign key (view_id, project_id, owner_id)
    references security_private.context_graph_saved_views(id, project_id, owner_id)
    on delete cascade,
  constraint context_graph_saved_view_shares_access_mode
    check (access_mode = 'public_readonly'),
  constraint context_graph_saved_view_shares_public_title
    check (char_length(public_title) between 1 and 120),
  constraint context_graph_saved_view_shares_token_hash_length
    check (octet_length(token_hash) = 32),
  constraint context_graph_saved_view_shares_source_lock
    check (source_view_lock_version >= 1),
  constraint context_graph_saved_view_shares_expiry
    check (expires_at > created_at),
  constraint context_graph_saved_view_shares_lock_version
    check (lock_version >= 1)
);

create index if not exists context_graph_saved_view_shares_owner_idx
  on security_private.context_graph_saved_view_shares
    (project_id, owner_id, updated_at desc, id);

-- PostgREST 14 still routes VOLATILE RPCs over GET, but runs them inside a
-- READ ONLY transaction.  This deliberately empty table provides a no-op
-- write gate: DELETE ... WHERE false changes no data for POST, while PostgreSQL
-- rejects GET/HEAD with SQLSTATE 25006 before a bearer token is inspected.
create table if not exists security_private.context_graph_share_post_guard (
  singleton boolean primary key default true check (singleton)
);

-- Sanitized append-only lifecycle audit while the owning project/view exists.
-- Account/project/view deletion cascades for privacy lifecycle compliance.  No
-- generic before/after payload is used, so token_hash is never copied here.
create table if not exists security_private.context_graph_saved_view_share_audit (
  id bigint generated always as identity primary key,
  action text not null check (action in ('created','rotated','updated','revoked')),
  actor_id uuid not null,
  share_id uuid not null,
  view_id uuid not null,
  project_id uuid not null,
  source_view_lock_version integer not null check (source_view_lock_version >= 1),
  policy_version smallint not null default 1 check (policy_version = 1),
  occurred_at timestamptz not null default now()
);

alter table security_private.context_graph_saved_view_share_audit
  drop constraint if exists context_graph_saved_view_share_audit_actor_fk,
  drop constraint if exists context_graph_saved_view_share_audit_share_fk,
  drop constraint if exists context_graph_saved_view_share_audit_view_fk,
  drop constraint if exists context_graph_saved_view_share_audit_project_fk,
  add constraint context_graph_saved_view_share_audit_actor_fk
    foreign key (actor_id) references auth.users(id) on delete cascade,
  add constraint context_graph_saved_view_share_audit_share_fk
    foreign key (share_id)
    references security_private.context_graph_saved_view_shares(id)
    on delete cascade,
  add constraint context_graph_saved_view_share_audit_view_fk
    foreign key (view_id)
    references security_private.context_graph_saved_views(id)
    on delete cascade,
  add constraint context_graph_saved_view_share_audit_project_fk
    foreign key (project_id) references public.projects(id) on delete cascade;

create index if not exists context_graph_saved_view_share_audit_lookup_idx
  on security_private.context_graph_saved_view_share_audit
    (project_id, view_id, occurred_at desc, id);

alter table security_private.context_graph_saved_view_shares enable row level security;
alter table security_private.context_graph_share_post_guard enable row level security;
alter table security_private.context_graph_saved_view_share_audit enable row level security;

drop policy if exists context_graph_saved_view_shares_owner_select
  on security_private.context_graph_saved_view_shares;
create policy context_graph_saved_view_shares_owner_select
on security_private.context_graph_saved_view_shares
for select to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.projects project
    where project.id = context_graph_saved_view_shares.project_id
      and project.owner_id = (select auth.uid())
  )
);

drop policy if exists context_graph_saved_view_shares_owner_insert
  on security_private.context_graph_saved_view_shares;
create policy context_graph_saved_view_shares_owner_insert
on security_private.context_graph_saved_view_shares
for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.projects project
    where project.id = context_graph_saved_view_shares.project_id
      and project.owner_id = (select auth.uid())
  )
);

drop policy if exists context_graph_saved_view_shares_owner_update
  on security_private.context_graph_saved_view_shares;
create policy context_graph_saved_view_shares_owner_update
on security_private.context_graph_saved_view_shares
for update to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.projects project
    where project.id = context_graph_saved_view_shares.project_id
      and project.owner_id = (select auth.uid())
  )
)
with check (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.projects project
    where project.id = context_graph_saved_view_shares.project_id
      and project.owner_id = (select auth.uid())
  )
);

-- Management functions call this before touching the private share row.  A
-- project editor can manage project data but cannot publish it to the Web.
create or replace function security_private.require_context_graph_share_project_owner_v1(
  p_project_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare actor_id uuid := auth.uid();
begin
  if auth.role() <> 'authenticated' or actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or not exists (
    select 1 from public.projects project
    where project.id = p_project_id and project.owner_id = actor_id
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_PROJECT_OWNER_REQUIRED'
      using errcode = '42501';
  end if;
  return actor_id;
end;
$function$;

create or replace function security_private.require_context_graph_share_owner_v1(
  p_project_id uuid,
  p_view_id uuid
)
returns security_private.context_graph_saved_views
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  actor_id uuid;
  view_row security_private.context_graph_saved_views%rowtype;
begin
  actor_id := security_private.require_context_graph_share_project_owner_v1(
    p_project_id
  );
  if p_project_id is null or p_view_id is null then
    raise exception 'CONTEXT_GRAPH_SHARE_VIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  select saved.* into view_row
  from security_private.context_graph_saved_views saved
  where saved.id = p_view_id
    and saved.project_id = p_project_id
    and saved.owner_id = actor_id;
  if not found then
    raise exception 'CONTEXT_GRAPH_SHARE_VIEW_NOT_FOUND' using errcode = 'P0002';
  end if;
  return view_row;
end;
$function$;

create or replace function security_private.context_graph_share_entity_public_v1(
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select case lower(coalesce(p_entity_type, ''))
    when 'person' then exists (
      select 1 from public.persons person
      where person.id = p_entity_id
        and person.project_id = p_project_id
        and not coalesce(person.is_living, false)
        and person.privacy_status = 'public'
        -- `is_living=false` is also the legacy "unknown" value.  Anonymous
        -- publication therefore requires a machine-parseable death bound that
        -- is wholly in the past.  Arbitrary imported text such as "?" or
        -- "невідомо" is not proof of death, and age is never inferred.
        and coalesce(
          security_private.context_partial_date_bound_v1(
            nullif(btrim(person.death_date), ''), false
          ),
          security_private.context_partial_date_bound_v1(
            nullif(btrim(person.death_year_to), ''), false
          ),
          security_private.context_partial_date_bound_v1(
            nullif(btrim(person.death_year_from), ''), false
          )
        ) <= current_date
    )
    when 'place' then exists (
      select 1 from public.places place
      where place.id = p_entity_id
        and (place.project_id is null or place.project_id = p_project_id)
        and place.is_public
        and place.status = 'active'
    )
    else false
  end;
$function$;

-- A saved configuration is publishable only when every identifier it carries
-- is already public.  Rejecting an unsafe filter is important: silently
-- dropping it could broaden the published graph.
create or replace function security_private.validate_context_graph_share_view_v1(
  p_view security_private.context_graph_saved_views
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if p_view.config_version <> 1
     or p_view.center_entity_type <> 'person'
     or not security_private.context_graph_share_entity_public_v1(
       p_view.project_id, 'person', p_view.center_entity_id
     ) then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  if p_view.has_evidence is not null then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from unnest(p_view.relation_type_ids) requested(value)
    where not exists (
      select 1 from public.context_relation_types relation_type
      where relation_type.id = requested.value
        and relation_type.project_id is null
        and relation_type.is_system
        and relation_type.is_active
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from unnest(p_view.place_ids) requested(value)
    where not security_private.context_graph_share_entity_public_v1(
      p_view.project_id, 'place', requested.value
    )
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
end;
$function$;

create or replace function security_private.context_graph_share_status_v1(
  p_share security_private.context_graph_saved_view_shares
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare view_row security_private.context_graph_saved_views%rowtype;
begin
  if p_share.revoked_at is not null then return 'revoked'; end if;
  if p_share.expires_at <= statement_timestamp() then return 'expired'; end if;
  -- Publication authority is dynamic. If project ownership changes, a link
  -- created by the former owner is suspended until the current owner creates
  -- a new one; ownership transfer must never preserve an old public grant.
  if not exists (
    select 1 from public.projects project
    where project.id = p_share.project_id
      and project.owner_id = p_share.owner_id
  ) then return 'suspended'; end if;
  select saved.* into view_row
  from security_private.context_graph_saved_views saved
  where saved.id = p_share.view_id
    and saved.project_id = p_share.project_id
    and saved.owner_id = p_share.owner_id
    and saved.lock_version = p_share.source_view_lock_version;
  if not found then return 'suspended'; end if;
  begin
    perform security_private.validate_context_graph_share_view_v1(view_row);
  exception when others then
    return 'suspended';
  end;
  return 'active';
end;
$function$;

create or replace function security_private.context_graph_share_meta_json_v1(
  p_share security_private.context_graph_saved_view_shares
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare status_value text;
begin
  status_value := security_private.context_graph_share_status_v1(p_share);
  return jsonb_build_object(
    'id', p_share.id,
    'accessMode', p_share.access_mode,
    'publicTitle', p_share.public_title,
    'expiresAt', p_share.expires_at,
    'revokedAt', p_share.revoked_at,
    'sourceViewLockVersion', p_share.source_view_lock_version,
    'lockVersion', p_share.lock_version,
    'createdAt', p_share.created_at,
    'rotatedAt', p_share.rotated_at,
    'updatedAt', p_share.updated_at,
    'status', status_value,
    'active', status_value = 'active'
  );
end;
$function$;

create or replace function security_private.context_graph_share_opaque_id_v1(
  p_salt bytea,
  p_kind text,
  p_id uuid
)
returns text
language sql
immutable
parallel safe
security definer
set search_path = pg_catalog, extensions, pg_temp
as $function$
  select rtrim(translate(encode(extensions.hmac(
    convert_to(lower(p_kind) || ':' || p_id::text, 'UTF8'),
    p_salt,
    'sha256'
  ), 'base64'), '+/', '-_'), '=');
$function$;

create or replace function security_private.context_graph_share_public_view_json_v1(
  p_share security_private.context_graph_saved_view_shares,
  p_view security_private.context_graph_saved_views
)
returns jsonb
language sql
stable
parallel safe
security definer
set search_path = pg_catalog, pg_temp
as $function$
  select jsonb_build_object(
    'title', p_share.public_title,
    'layoutId', p_view.layout_id,
    'zoom', p_view.zoom,
    'viewport', p_view.viewport
  );
$function$;

-- Public projection built only from explicitly public rows.  It does not call
-- the member graph and then redact it: private rows never enter the recursive
-- graph, its node/edge counts, or its truncation flags.
create or replace function security_private.get_public_context_graph_share_v1(
  p_view security_private.context_graph_saved_views,
  p_share_salt bytea
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  result jsonb;
  focus_from date;
  focus_to date;
  date_filter_active boolean;
begin
  perform security_private.validate_context_graph_share_view_v1(p_view);
  focus_from := coalesce(
    p_view.focus_date,
    case when p_view.focus_year is null then null
      else make_date(p_view.focus_year, 1, 1) end
  );
  focus_to := coalesce(
    p_view.focus_date,
    case when p_view.focus_year is null then null
      else make_date(p_view.focus_year, 12, 31) end
  );
  date_filter_active := focus_from is not null
    or p_view.valid_from is not null or p_view.valid_to is not null;
  with recursive
  public_relations as materialized (
    select relation.*,
      relation_type.code relation_type_code,
      relation_type.label_uk relation_type_label,
      relation_type.category relation_category,
      relation_type.directionality,
      case when relation.valid_from is null and relation.valid_to is null
        then security_private.context_partial_date_bound_v1(
          relation.period_text, true
        ) else relation.valid_from end effective_valid_from,
      case when relation.valid_from is null and relation.valid_to is null
        then security_private.context_partial_date_bound_v1(
          relation.period_text, false
        ) else relation.valid_to end effective_valid_to
    from public.context_relations relation
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
      and relation_type.project_id is null
      and relation_type.is_system
      and relation_type.is_active
    where relation.project_id = p_view.project_id
      and relation.deleted_at is null
      and relation.privacy_status = 'public'
      and relation.source_entity_type in ('person', 'place')
      and relation.target_entity_type in ('person', 'place')
      and security_private.context_graph_share_entity_public_v1(
        p_view.project_id, relation.source_entity_type,
        relation.source_entity_id
      )
      and security_private.context_graph_share_entity_public_v1(
        p_view.project_id, relation.target_entity_type,
        relation.target_entity_id
      )
      and (
        relation.source_entity_type = 'person'
        and relation.source_entity_id = p_view.center_entity_id
        or relation.source_entity_type = any(p_view.entity_types)
      )
      and (
        relation.target_entity_type = 'person'
        and relation.target_entity_id = p_view.center_entity_id
        or relation.target_entity_type = any(p_view.entity_types)
      )
      and (
        cardinality(p_view.relation_type_ids) = 0
        or relation.relation_type_id = any(p_view.relation_type_ids)
      )
      and (
        cardinality(p_view.evidence_statuses) = 0
        or relation.evidence_status = any(p_view.evidence_statuses)
      )
      and (
        cardinality(p_view.assertion_kinds) = 0
        or relation.assertion_kind = any(p_view.assertion_kinds)
      )
      and (
        p_view.valid_from is null
        or coalesce(
          relation.valid_to,
          security_private.context_partial_date_bound_v1(
            relation.period_text, false
          )
        ) is null
        or coalesce(
          relation.valid_to,
          security_private.context_partial_date_bound_v1(
            relation.period_text, false
          )
        ) >= p_view.valid_from
      )
      and (
        p_view.valid_to is null
        or coalesce(
          relation.valid_from,
          security_private.context_partial_date_bound_v1(
            relation.period_text, true
          )
        ) is null
        or coalesce(
          relation.valid_from,
          security_private.context_partial_date_bound_v1(
            relation.period_text, true
          )
        ) <= p_view.valid_to
      )
      and (
        not date_filter_active or p_view.include_undated
        or relation.valid_from is not null or relation.valid_to is not null
        or security_private.context_partial_date_bound_v1(
          relation.period_text, true
        ) is not null
      )
      and (
        focus_from is null
        or coalesce(
          relation.valid_to,
          security_private.context_partial_date_bound_v1(
            relation.period_text, false
          )
        ) is null
        or coalesce(
          relation.valid_to,
          security_private.context_partial_date_bound_v1(
            relation.period_text, false
          )
        ) >= focus_from
      )
      and (
        focus_to is null
        or coalesce(
          relation.valid_from,
          security_private.context_partial_date_bound_v1(
            relation.period_text, true
          )
        ) is null
        or coalesce(
          relation.valid_from,
          security_private.context_partial_date_bound_v1(
            relation.period_text, true
          )
        ) <= focus_to
      )
      and (
        p_view.min_confidence is null
        or relation.confidence >= p_view.min_confidence
      )
      and (
        cardinality(p_view.place_ids) = 0
        or (
          relation.source_entity_type = 'place'
          and relation.source_entity_id = any(p_view.place_ids)
        )
        or (
          relation.target_entity_type = 'place'
          and relation.target_entity_id = any(p_view.place_ids)
        )
      )
  ), directed_edges as materialized (
    select relation.id relation_id,
      relation.source_entity_type from_type,
      relation.source_entity_id from_id,
      relation.target_entity_type to_type,
      relation.target_entity_id to_id,
      relation.updated_at
    from public_relations relation
    union all
    select relation.id, relation.target_entity_type,
      relation.target_entity_id, relation.source_entity_type,
      relation.source_entity_id, relation.updated_at
    from public_relations relation
  ), walk(entity_type, entity_id, depth) as (
    select 'person'::text, p_view.center_entity_id, 0
    union
    select edge.to_type, edge.to_id, walk.depth + 1
    from walk
    join directed_edges edge
      on edge.from_type = walk.entity_type and edge.from_id = walk.entity_id
    where walk.depth < p_view.depth
  ), reachable_nodes as (
    select walk.entity_type, walk.entity_id, min(walk.depth) depth
    from walk group by walk.entity_type, walk.entity_id
  ), node_activity as (
    select reachable.entity_type, reachable.entity_id, reachable.depth,
      max(edge.updated_at) latest_relation_at
    from reachable_nodes reachable
    left join directed_edges edge
      on edge.from_type = reachable.entity_type
      and edge.from_id = reachable.entity_id
    group by reachable.entity_type, reachable.entity_id, reachable.depth
  ), ranked_nodes as (
    select activity.*, row_number() over(order by activity.depth,
      (activity.entity_type = 'person'
        and activity.entity_id = p_view.center_entity_id) desc,
      activity.latest_relation_at desc nulls last,
      activity.entity_type, activity.entity_id) node_rank
    from node_activity activity
  ), candidate_nodes as materialized (
    select ranked.* from ranked_nodes ranked
    where ranked.node_rank <= p_view.max_nodes
  ), candidate_edges as materialized (
    select relation.*,
      greatest(source_node.depth, target_node.depth) graph_depth
    from public_relations relation
    join candidate_nodes source_node
      on source_node.entity_type = relation.source_entity_type
      and source_node.entity_id = relation.source_entity_id
    join candidate_nodes target_node
      on target_node.entity_type = relation.target_entity_type
      and target_node.entity_id = relation.target_entity_id
  ), ranked_edges as (
    select edge.*, row_number() over(order by edge.graph_depth,
      edge.updated_at desc, edge.id) edge_rank
    from candidate_edges edge
  ), selected_edges as materialized (
    select ranked.* from ranked_edges ranked
    where ranked.edge_rank <= p_view.max_edges
  ), final_node_keys as (
    select 'person'::text entity_type,
      p_view.center_entity_id entity_id
    union select edge.source_entity_type, edge.source_entity_id
      from selected_edges edge
    union select edge.target_entity_type, edge.target_entity_id
      from selected_edges edge
  ), selected_nodes as materialized (
    select candidate.* from candidate_nodes candidate
    join final_node_keys key
      on key.entity_type = candidate.entity_type
      and key.entity_id = candidate.entity_id
  ), node_rows as (
    select node.node_rank, jsonb_build_object(
      'id', security_private.context_graph_share_opaque_id_v1(
        p_share_salt, node.entity_type, node.entity_id
      ),
      'type', node.entity_type,
      'label', case node.entity_type
        when 'person' then coalesce(nullif(person.full_name, ''), 'Особа')
        else place.canonical_name end,
      'secondary', case node.entity_type
        when 'person' then nullif(btrim(concat_ws(' – ',
          nullif(person.birth_date, ''), nullif(person.death_date, '')
        )), '')
        else nullif(place.modern_name, '') end,
      'isCenter', node.entity_type = 'person'
        and node.entity_id = p_view.center_entity_id,
      'depth', node.depth
    ) payload
    from selected_nodes node
    left join public.persons person
      on node.entity_type = 'person'
      and person.id = node.entity_id
      and person.project_id = p_view.project_id
    left join public.places place
      on node.entity_type = 'place' and place.id = node.entity_id
  ), edge_rows as (
    select edge.edge_rank, jsonb_build_object(
      'id', security_private.context_graph_share_opaque_id_v1(
        p_share_salt, 'relation', edge.id
      ),
      'source', security_private.context_graph_share_opaque_id_v1(
        p_share_salt, edge.source_entity_type, edge.source_entity_id
      ),
      'target', security_private.context_graph_share_opaque_id_v1(
        p_share_salt, edge.target_entity_type, edge.target_entity_id
      ),
      'label', edge.relation_type_label,
      'directionality', edge.directionality,
      'status', edge.evidence_status,
      'confidence', edge.confidence,
      'assertionKind', edge.assertion_kind,
      'generated', edge.assertion_kind = 'generated'
    ) payload
    from selected_edges edge
  )
  select jsonb_build_object(
    'centerNodeId', security_private.context_graph_share_opaque_id_v1(
      p_share_salt, 'person', p_view.center_entity_id
    ),
    'nodes', coalesce((
      select jsonb_agg(node.payload order by node.node_rank)
      from node_rows node
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(edge.payload order by edge.edge_rank)
      from edge_rows edge
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$function$;

create or replace function security_private.list_context_graph_view_shares_v1(
  p_project_id uuid,
  p_view_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  view_row security_private.context_graph_saved_views%rowtype;
  result jsonb;
begin
  view_row := security_private.require_context_graph_share_owner_v1(
    p_project_id, p_view_id
  );
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(
      security_private.context_graph_share_meta_json_v1(share_row)
    ), '[]'::jsonb),
    'total', count(*)::integer
  ) into result
  from security_private.context_graph_saved_view_shares share_row
  where share_row.view_id = view_row.id
    and share_row.project_id = view_row.project_id
    and share_row.owner_id = view_row.owner_id;
  return result;
end;
$function$;

create or replace function security_private.create_context_graph_view_share_v1(
  p_project_id uuid,
  p_view_id uuid,
  p_access_mode text default 'public_readonly',
  p_expires_at timestamptz default null,
  p_public_title text default null,
  p_expected_lock_version integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, extensions, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  view_row security_private.context_graph_saved_views%rowtype;
  share_row security_private.context_graph_saved_view_shares%rowtype;
  raw_token text;
  token_digest bytea;
  effective_expiry timestamptz;
  normalized_title text;
  previous_share_id uuid;
  previous_share_lock integer;
  now_value timestamptz := clock_timestamp();
begin
  view_row := security_private.require_context_graph_share_owner_v1(
    p_project_id, p_view_id
  );
  if lower(btrim(coalesce(p_access_mode, ''))) <> 'public_readonly' then
    raise exception 'CONTEXT_GRAPH_SHARE_ACCESS_MODE_INVALID'
      using errcode = '22023';
  end if;
  effective_expiry := coalesce(p_expires_at, now_value + interval '30 days');
  if effective_expiry < now_value + interval '5 minutes'
     or effective_expiry > now_value + interval '90 days' then
    raise exception 'CONTEXT_GRAPH_SHARE_EXPIRY_OUT_OF_RANGE'
      using errcode = '22023';
  end if;
  normalized_title := btrim(coalesce(
    nullif(p_public_title, ''), 'Спільний дослідницький граф'
  ));
  if char_length(normalized_title) < 1 or char_length(normalized_title) > 120
     or normalized_title ~ '[[:cntrl:]]' then
    raise exception 'CONTEXT_GRAPH_SHARE_PUBLIC_TITLE_INVALID'
      using errcode = '22023';
  end if;
  perform security_private.validate_context_graph_share_view_v1(view_row);
  perform pg_advisory_xact_lock(hashtextextended(
    'context_graph_share:' || view_row.id::text, 0
  ));
  select share.id, share.lock_version
  into previous_share_id, previous_share_lock
  from security_private.context_graph_saved_view_shares share
  where share.view_id = view_row.id
  for update;
  if previous_share_id is null and p_expected_lock_version is not null then
    raise exception 'CONTEXT_GRAPH_SHARE_VERSION_CONFLICT'
      using errcode = '40001';
  end if;
  if previous_share_id is not null and (
    p_expected_lock_version is null
    or p_expected_lock_version <> previous_share_lock
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_VERSION_CONFLICT'
      using errcode = '40001';
  end if;
  raw_token := rtrim(translate(
    encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'
  ), '=');
  token_digest := extensions.digest(raw_token, 'sha256');

  insert into security_private.context_graph_saved_view_shares (
    view_id, project_id, owner_id, access_mode, public_title,
    token_hash, source_view_lock_version, expires_at, revoked_at,
    revoked_by, lock_version, created_at, rotated_at, updated_at
  ) values (
    view_row.id, view_row.project_id, actor_id, 'public_readonly',
    normalized_title, token_digest, view_row.lock_version,
    effective_expiry, null, null, 1, now_value, now_value, now_value
  )
  on conflict (view_id) do update
  set access_mode = excluded.access_mode,
      public_title = excluded.public_title,
      token_hash = excluded.token_hash,
      source_view_lock_version = excluded.source_view_lock_version,
      expires_at = excluded.expires_at,
      revoked_at = null,
      revoked_by = null,
      lock_version = context_graph_saved_view_shares.lock_version + 1,
      rotated_at = now_value,
      updated_at = now_value
  returning * into share_row;

  insert into security_private.context_graph_saved_view_share_audit (
    action, actor_id, share_id, view_id, project_id,
    source_view_lock_version, policy_version, occurred_at
  ) values (
    case when previous_share_id is null then 'created' else 'rotated' end,
    actor_id, share_row.id, view_row.id, view_row.project_id,
    view_row.lock_version, 1, now_value
  );

  return jsonb_build_object(
    'share', security_private.context_graph_share_meta_json_v1(share_row),
    'token', raw_token
  );
end;
$function$;

create or replace function security_private.update_context_graph_view_share_v1(
  p_project_id uuid,
  p_share_id uuid,
  p_access_mode text,
  p_expires_at timestamptz,
  p_public_title text,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  share_row security_private.context_graph_saved_view_shares%rowtype;
  normalized_title text := btrim(coalesce(p_public_title, ''));
  now_value timestamptz := clock_timestamp();
begin
  actor_id := security_private.require_context_graph_share_project_owner_v1(
    p_project_id
  );
  select share.* into share_row
  from security_private.context_graph_saved_view_shares share
  where share.id = p_share_id and share.project_id = p_project_id
    and share.owner_id = actor_id;
  if not found then
    raise exception 'CONTEXT_GRAPH_SHARE_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform security_private.require_context_graph_share_owner_v1(
    p_project_id, share_row.view_id
  );
  if lower(btrim(coalesce(p_access_mode, ''))) <> 'public_readonly' then
    raise exception 'CONTEXT_GRAPH_SHARE_ACCESS_MODE_INVALID'
      using errcode = '22023';
  end if;
  if p_expires_at is null
     or p_expires_at < now_value + interval '5 minutes'
     or p_expires_at > now_value + interval '90 days' then
    raise exception 'CONTEXT_GRAPH_SHARE_EXPIRY_OUT_OF_RANGE'
      using errcode = '22023';
  end if;
  if char_length(normalized_title) < 1 or char_length(normalized_title) > 120
     or normalized_title ~ '[[:cntrl:]]' then
    raise exception 'CONTEXT_GRAPH_SHARE_PUBLIC_TITLE_INVALID'
      using errcode = '22023';
  end if;
  if p_expected_lock_version is null or p_expected_lock_version < 1 then
    raise exception 'CONTEXT_GRAPH_SHARE_EXPECTED_LOCK_REQUIRED'
      using errcode = '22023';
  end if;
  update security_private.context_graph_saved_view_shares share
  set public_title = normalized_title,
      expires_at = p_expires_at,
      lock_version = share.lock_version + 1,
      updated_at = now_value
  where share.id = share_row.id
    and share.project_id = p_project_id
    and share.owner_id = actor_id
    and share.revoked_at is null
    and share.expires_at > now_value
    and share.lock_version = p_expected_lock_version
  returning share.* into share_row;
  if not found then
    if exists (
      select 1 from security_private.context_graph_saved_view_shares share
      where share.id = p_share_id and share.project_id = p_project_id
        and share.owner_id = actor_id
        and share.revoked_at is null and share.expires_at > now_value
    ) then
      raise exception 'CONTEXT_GRAPH_SHARE_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
    raise exception 'CONTEXT_GRAPH_SHARE_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into security_private.context_graph_saved_view_share_audit (
    action, actor_id, share_id, view_id, project_id,
    source_view_lock_version, policy_version, occurred_at
  ) values (
    'updated', actor_id, share_row.id, share_row.view_id,
    share_row.project_id, share_row.source_view_lock_version, 1, now_value
  );
  return jsonb_build_object(
    'share', security_private.context_graph_share_meta_json_v1(share_row)
  );
end;
$function$;

create or replace function security_private.revoke_context_graph_view_share_v1(
  p_project_id uuid,
  p_share_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '3s'
as $function$
declare
  actor_id uuid := auth.uid();
  share_row security_private.context_graph_saved_view_shares%rowtype;
  now_value timestamptz := clock_timestamp();
begin
  actor_id := security_private.require_context_graph_share_project_owner_v1(
    p_project_id
  );
  select share.* into share_row
  from security_private.context_graph_saved_view_shares share
  where share.id = p_share_id and share.project_id = p_project_id
    and share.owner_id = actor_id;
  if not found then
    raise exception 'CONTEXT_GRAPH_SHARE_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform security_private.require_context_graph_share_owner_v1(
    p_project_id, share_row.view_id
  );
  if p_expected_lock_version is null or p_expected_lock_version < 1 then
    raise exception 'CONTEXT_GRAPH_SHARE_EXPECTED_LOCK_REQUIRED'
      using errcode = '22023';
  end if;
  update security_private.context_graph_saved_view_shares share
  set revoked_at = now_value,
      revoked_by = actor_id,
      lock_version = share.lock_version + 1,
      updated_at = now_value
  where share.id = share_row.id
    and share.project_id = p_project_id
    and share.owner_id = actor_id
    and share.revoked_at is null
    and share.lock_version = p_expected_lock_version
  returning share.* into share_row;
  if not found then
    if exists (
      select 1 from security_private.context_graph_saved_view_shares share
      where share.id = p_share_id and share.project_id = p_project_id
        and share.owner_id = actor_id and share.revoked_at is null
    ) then
      raise exception 'CONTEXT_GRAPH_SHARE_VERSION_CONFLICT'
        using errcode = '40001';
    end if;
    raise exception 'CONTEXT_GRAPH_SHARE_NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into security_private.context_graph_saved_view_share_audit (
    action, actor_id, share_id, view_id, project_id,
    source_view_lock_version, policy_version, occurred_at
  ) values (
    'revoked', actor_id, share_row.id, share_row.view_id,
    share_row.project_id, share_row.source_view_lock_version, 1, now_value
  );
  return jsonb_build_object(
    'share', security_private.context_graph_share_meta_json_v1(share_row)
  );
end;
$function$;

create or replace function security_private.get_shared_context_graph_view_v1(
  p_token text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, extensions, pg_temp
set statement_timeout = '6s'
as $function$
declare
  share_row security_private.context_graph_saved_view_shares%rowtype;
  view_row security_private.context_graph_saved_views%rowtype;
begin
  if auth.role() not in ('anon', 'authenticated') then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  -- A no-op in POST's READ WRITE transaction; GET/HEAD fail here with 25006.
  delete from security_private.context_graph_share_post_guard where false;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  select share.* into share_row
  from security_private.context_graph_saved_view_shares share
  where share.token_hash = extensions.digest(p_token, 'sha256')
    and share.access_mode = 'public_readonly'
    and share.revoked_at is null
    and share.expires_at > clock_timestamp();
  if not found then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.projects project
    where project.id = share_row.project_id
      and project.owner_id = share_row.owner_id
  ) then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  select saved.* into view_row
  from security_private.context_graph_saved_views saved
  where saved.id = share_row.view_id
    and saved.project_id = share_row.project_id
    and saved.owner_id = share_row.owner_id
    and saved.lock_version = share_row.source_view_lock_version;
  if not found then
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
  end if;
  perform security_private.validate_context_graph_share_view_v1(view_row);
  return jsonb_build_object(
    'share', jsonb_build_object(
      'accessMode', 'public_readonly',
      'expiresAt', share_row.expires_at
    ),
    'view', security_private.context_graph_share_public_view_json_v1(
      share_row, view_row
    ),
    'graph', security_private.get_public_context_graph_share_v1(
      view_row, share_row.token_hash
    )
  );
exception
  when others then
    -- Preserve HTTP semantics: PostgREST maps the write attempted by GET/HEAD
    -- in a READ ONLY transaction to 405.  Never hide it as a resolver result.
    if sqlstate in ('25006', '57014') then raise; end if;
    raise exception 'CONTEXT_GRAPH_SHARE_UNAVAILABLE' using errcode = 'P0002';
end;
$function$;

-- Local-development compatibility: an early 023 draft briefly had this
-- one-argument private overload.  It never existed in production.
drop function if exists security_private.get_public_context_graph_share_v1(
  security_private.context_graph_saved_views
);
drop function if exists public.create_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text
);
drop function if exists security_private.create_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text
);

-- SECURITY INVOKER public facades.  Only the checked private implementations
-- receive narrowly scoped EXECUTE grants below.
create or replace function public.list_context_graph_view_shares_v1(
  p_project_id uuid, p_view_id uuid
)
returns jsonb language sql stable security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.list_context_graph_view_shares_v1($1, $2);
$function$;

create or replace function public.create_context_graph_view_share_v1(
  p_project_id uuid,
  p_view_id uuid,
  p_access_mode text default 'public_readonly',
  p_expires_at timestamptz default null,
  p_public_title text default null,
  p_expected_lock_version integer default null
)
returns jsonb language sql volatile security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.create_context_graph_view_share_v1(
    $1, $2, $3, $4, $5, $6
  );
$function$;

create or replace function public.update_context_graph_view_share_v1(
  p_project_id uuid,
  p_share_id uuid,
  p_access_mode text,
  p_expires_at timestamptz,
  p_public_title text,
  p_expected_lock_version integer
)
returns jsonb language sql volatile security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.update_context_graph_view_share_v1(
    $1, $2, $3, $4, $5, $6
  );
$function$;

create or replace function public.revoke_context_graph_view_share_v1(
  p_project_id uuid,
  p_share_id uuid,
  p_expected_lock_version integer
)
returns jsonb language sql volatile security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.revoke_context_graph_view_share_v1($1, $2, $3);
$function$;

create or replace function public.get_shared_context_graph_view_v1(
  p_token text
)
returns jsonb language sql volatile security invoker
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select security_private.get_shared_context_graph_view_v1($1);
$function$;

revoke all on table security_private.context_graph_saved_view_shares
from public, anon, authenticated, service_role;
revoke all on table security_private.context_graph_share_post_guard
from public, anon, authenticated, service_role;
revoke all on table security_private.context_graph_saved_view_share_audit
from public, anon, authenticated, service_role;

do $context_graph_share_private_acl$
declare function_record record;
begin
  for function_record in
    select procedure.oid::regprocedure signature
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'security_private'
      and procedure.proname = any(array[
        'require_context_graph_share_project_owner_v1',
        'require_context_graph_share_owner_v1',
        'context_graph_share_entity_public_v1',
        'validate_context_graph_share_view_v1',
        'context_graph_share_status_v1',
        'context_graph_share_meta_json_v1',
        'context_graph_share_opaque_id_v1',
        'context_graph_share_public_view_json_v1',
        'get_public_context_graph_share_v1',
        'list_context_graph_view_shares_v1',
        'create_context_graph_view_share_v1',
        'update_context_graph_view_share_v1',
        'revoke_context_graph_view_share_v1',
        'get_shared_context_graph_view_v1'
      ]::text[])
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_record.signature
    );
  end loop;
end;
$context_graph_share_private_acl$;

grant execute on function security_private.list_context_graph_view_shares_v1(
  uuid, uuid
) to authenticated;
grant execute on function security_private.create_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) to authenticated;
grant execute on function security_private.update_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) to authenticated;
grant execute on function security_private.revoke_context_graph_view_share_v1(
  uuid, uuid, integer
) to authenticated;
grant execute on function security_private.get_shared_context_graph_view_v1(text)
to anon, authenticated;

revoke all on function public.list_context_graph_view_shares_v1(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.create_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.update_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) from public, anon, authenticated, service_role;
revoke all on function public.revoke_context_graph_view_share_v1(
  uuid, uuid, integer
) from public, anon, authenticated, service_role;
revoke all on function public.get_shared_context_graph_view_v1(text)
from public, anon, authenticated, service_role;

grant execute on function public.list_context_graph_view_shares_v1(uuid, uuid)
to authenticated;
grant execute on function public.create_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) to authenticated;
grant execute on function public.update_context_graph_view_share_v1(
  uuid, uuid, text, timestamptz, text, integer
) to authenticated;
grant execute on function public.revoke_context_graph_view_share_v1(
  uuid, uuid, integer
) to authenticated;
grant execute on function public.get_shared_context_graph_view_v1(text)
to anon, authenticated;

notify pgrst, 'reload schema';

commit;
