begin;

-- Security Advisor reports the Zagulyaky RPCs because their privileged
-- implementations currently live in the Data API schema.  Keep the public
-- contract (name, arguments, defaults, volatility and ACL) intact, but move
-- privileged work to the already non-exposed security_private schema and
-- leave SECURITY INVOKER compatibility facades in public.
--
-- Do not add security_private to pgrst.db_schemas.  The anonymous catalogue
-- facades below require USAGE plus EXECUTE on only four private functions;
-- PostgREST schema isolation is what keeps those implementations unreachable
-- as direct RPC endpoints.
create schema if not exists security_private;
comment on schema security_private is
  'Trusted SECURITY DEFINER implementations. Do not add this schema to the PostgREST exposed schemas list.';

do $exposed_schema_guard$
begin
  if 'security_private' = any(
    pg_catalog.regexp_split_to_array(
      coalesce(pg_catalog.current_setting('pgrst.db_schemas', true), ''),
      '[[:space:]]*,[[:space:]]*'
    )
  ) then
    raise exception 'SECURITY_PRIVATE_SCHEMA_MUST_NOT_BE_EXPOSED';
  end if;
end;
$exposed_schema_guard$;

revoke all on schema security_private from public;
revoke create on schema security_private from anon, authenticated, service_role;
grant usage on schema security_private to anon, authenticated, service_role;
revoke create on schema public from public, anon, authenticated, service_role;

alter default privileges in schema security_private
  revoke execute on functions from public;

-- `security_private.get_public_zagulyaka_v1(text)` is the existing raw
-- projection helper.  Rename the current public redaction facade before
-- moving it so its OID, body and dependencies survive without colliding with
-- that helper or accidentally becoming recursive.
do $public_detail_name_guard$
begin
  if to_regprocedure('security_private.get_public_zagulyaka_api_v1(text)') is not null then
    raise exception 'ZAGULYAKA_PUBLIC_DETAIL_IMPLEMENTATION_ALREADY_EXISTS';
  end if;
end;
$public_detail_name_guard$;

alter function public.get_public_zagulyaka_v1(text)
  rename to get_public_zagulyaka_api_v1;
alter function public.get_public_zagulyaka_api_v1(text)
  set schema security_private;

-- ALTER ... SET SCHEMA retains the implementation OID, owner, body, explicit
-- search_path and dependency graph.  No function is dropped or rewritten.
alter function public.admin_list_zagulyaky_claims_v1(text, integer, integer)
  set schema security_private;
alter function public.admin_list_zagulyaky_queue_v1(text, integer, integer)
  set schema security_private;
alter function public.admin_review_zagulyaka_v1(uuid, integer, text, text, text, text, text)
  set schema security_private;
alter function public.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text)
  set schema security_private;
alter function public.confirm_zagulyaka_v1(uuid, text, text)
  set schema security_private;
alter function public.create_zagulyaka_claim_v1(uuid, text, text)
  set schema security_private;
alter function public.create_zagulyaka_draft_v1(text, jsonb)
  set schema security_private;
alter function public.delete_my_zagulyaka_attachment_v2(uuid, uuid, integer)
  set schema security_private;
alter function public.delete_my_zagulyaka_draft_v3(uuid, integer)
  set schema security_private;
alter function public.delete_my_zagulyaky_saved_place_v1(uuid)
  set schema security_private;
alter function public.delete_my_zagulyaky_saved_source_preset_v1(uuid)
  set schema security_private;
alter function public.get_my_zagulyaka_draft_v1(uuid)
  set schema security_private;
alter function public.get_my_zagulyaky_page_v1(text, integer, integer)
  set schema security_private;
alter function public.get_my_zagulyaky_v1(text, integer, integer)
  set schema security_private;
alter function public.get_zagulyaky_public_stats_v1()
  set schema security_private;
alter function public.list_my_zagulyaky_saved_places_v1(text, integer)
  set schema security_private;
alter function public.list_my_zagulyaky_saved_source_presets_v1(text, integer)
  set schema security_private;
alter function public.replace_my_zagulyaka_details_v1(uuid, integer, jsonb, jsonb, jsonb)
  set schema security_private;
alter function public.search_zagulyaky_documents_v1(text, jsonb, integer, timestamptz, uuid)
  set schema security_private;
alter function public.search_zagulyaky_people_v1(text, jsonb, integer, timestamptz, uuid)
  set schema security_private;
alter function public.set_zagulyaka_bookmark_v1(uuid, boolean)
  set schema security_private;
alter function public.submit_zagulyaka_v1(uuid, integer)
  set schema security_private;
alter function public.update_my_zagulyaka_draft_v1(uuid, integer, jsonb)
  set schema security_private;
alter function public.upsert_my_zagulyaky_saved_place_v1(jsonb)
  set schema security_private;
alter function public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb)
  set schema security_private;
alter function public.withdraw_zagulyaka_v1(uuid, integer)
  set schema security_private;

-- Public compatibility facades.  Parameter names/defaults deliberately match
-- the previous RPC contracts so PostgREST named-argument calls keep working.
create function public.admin_list_zagulyaky_claims_v1(
  p_status text default 'open',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.admin_list_zagulyaky_claims_v1($1, $2, $3);
$wrapper$;

create function public.admin_list_zagulyaky_queue_v1(
  p_status text default 'pending_review',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.admin_list_zagulyaky_queue_v1($1, $2, $3);
$wrapper$;

create function public.admin_review_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_action text,
  p_note text default '',
  p_verification_status text default null,
  p_privacy_status text default null,
  p_public_slug text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.admin_review_zagulyaka_v1($1, $2, $3, $4, $5, $6, $7);
$wrapper$;

create function public.attach_my_zagulyaka_file_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.attach_my_zagulyaka_file_v1($1, $2, $3, $4, $5, $6, $7);
$wrapper$;

create function public.confirm_zagulyaka_v1(
  p_record_id uuid,
  p_confirmation_type text default 'confirm',
  p_comment text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.confirm_zagulyaka_v1($1, $2, $3);
$wrapper$;

create function public.create_zagulyaka_claim_v1(
  p_record_id uuid,
  p_claim_type text,
  p_message text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.create_zagulyaka_claim_v1($1, $2, $3);
$wrapper$;

create function public.create_zagulyaka_draft_v1(
  p_kind text,
  p_record jsonb default '{}'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.create_zagulyaka_draft_v1($1, $2);
$wrapper$;

create function public.delete_my_zagulyaka_attachment_v2(
  p_record_id uuid,
  p_attachment_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_my_zagulyaka_attachment_v2($1, $2, $3);
$wrapper$;

create function public.delete_my_zagulyaka_draft_v3(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_my_zagulyaka_draft_v3($1, $2);
$wrapper$;

create function public.delete_my_zagulyaky_saved_place_v1(p_place_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_my_zagulyaky_saved_place_v1($1);
$wrapper$;

create function public.delete_my_zagulyaky_saved_source_preset_v1(p_source_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_my_zagulyaky_saved_source_preset_v1($1);
$wrapper$;

create function public.get_my_zagulyaka_draft_v1(p_record_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_my_zagulyaka_draft_v1($1);
$wrapper$;

create function public.get_my_zagulyaky_page_v1(
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_my_zagulyaky_page_v1($1, $2, $3);
$wrapper$;

create function public.get_my_zagulyaky_v1(
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_my_zagulyaky_v1($1, $2, $3);
$wrapper$;

create function public.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_public_zagulyaka_api_v1($1);
$wrapper$;

create function public.get_zagulyaky_public_stats_v1()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_zagulyaky_public_stats_v1();
$wrapper$;

create function public.list_my_zagulyaky_saved_places_v1(
  p_query text default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_my_zagulyaky_saved_places_v1($1, $2);
$wrapper$;

create function public.list_my_zagulyaky_saved_source_presets_v1(
  p_query text default null,
  p_limit integer default 100
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_my_zagulyaky_saved_source_presets_v1($1, $2);
$wrapper$;

create function public.replace_my_zagulyaka_details_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_sources jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_document_discoveries jsonb default '[]'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.replace_my_zagulyaka_details_v1($1, $2, $3, $4, $5);
$wrapper$;

create function public.search_zagulyaky_documents_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.search_zagulyaky_documents_v1($1, $2, $3, $4, $5);
$wrapper$;

create function public.search_zagulyaky_people_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.search_zagulyaky_people_v1($1, $2, $3, $4, $5);
$wrapper$;

create function public.set_zagulyaka_bookmark_v1(
  p_record_id uuid,
  p_bookmarked boolean
)
returns boolean
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.set_zagulyaka_bookmark_v1($1, $2);
$wrapper$;

create function public.submit_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.submit_zagulyaka_v1($1, $2);
$wrapper$;

create function public.update_my_zagulyaka_draft_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.update_my_zagulyaka_draft_v1($1, $2, $3);
$wrapper$;

create function public.upsert_my_zagulyaky_saved_place_v1(p_place jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.upsert_my_zagulyaky_saved_place_v1($1);
$wrapper$;

create function public.upsert_my_zagulyaky_saved_source_preset_v1(p_source jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.upsert_my_zagulyaky_saved_source_preset_v1($1);
$wrapper$;

create function public.withdraw_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.withdraw_zagulyaka_v1($1, $2);
$wrapper$;

-- New functions default to PUBLIC EXECUTE.  Reapply the narrow established
-- contract on both the facades and their private implementations.
revoke all on function
  security_private.get_public_zagulyaka_api_v1(text),
  security_private.get_zagulyaky_public_stats_v1(),
  security_private.search_zagulyaky_documents_v1(text, jsonb, integer, timestamptz, uuid),
  security_private.search_zagulyaky_people_v1(text, jsonb, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.get_public_zagulyaka_api_v1(text),
  security_private.get_zagulyaky_public_stats_v1(),
  security_private.search_zagulyaky_documents_v1(text, jsonb, integer, timestamptz, uuid),
  security_private.search_zagulyaky_people_v1(text, jsonb, integer, timestamptz, uuid)
  to anon, authenticated, service_role;

revoke all on function
  security_private.admin_list_zagulyaky_claims_v1(text, integer, integer),
  security_private.admin_list_zagulyaky_queue_v1(text, integer, integer),
  security_private.admin_review_zagulyaka_v1(uuid, integer, text, text, text, text, text),
  security_private.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text),
  security_private.confirm_zagulyaka_v1(uuid, text, text),
  security_private.create_zagulyaka_claim_v1(uuid, text, text),
  security_private.create_zagulyaka_draft_v1(text, jsonb),
  security_private.delete_my_zagulyaka_attachment_v2(uuid, uuid, integer),
  security_private.delete_my_zagulyaka_draft_v3(uuid, integer),
  security_private.delete_my_zagulyaky_saved_place_v1(uuid),
  security_private.delete_my_zagulyaky_saved_source_preset_v1(uuid),
  security_private.get_my_zagulyaka_draft_v1(uuid),
  security_private.get_my_zagulyaky_page_v1(text, integer, integer),
  security_private.get_my_zagulyaky_v1(text, integer, integer),
  security_private.list_my_zagulyaky_saved_places_v1(text, integer),
  security_private.list_my_zagulyaky_saved_source_presets_v1(text, integer),
  security_private.replace_my_zagulyaka_details_v1(uuid, integer, jsonb, jsonb, jsonb),
  security_private.set_zagulyaka_bookmark_v1(uuid, boolean),
  security_private.submit_zagulyaka_v1(uuid, integer),
  security_private.update_my_zagulyaka_draft_v1(uuid, integer, jsonb),
  security_private.upsert_my_zagulyaky_saved_place_v1(jsonb),
  security_private.upsert_my_zagulyaky_saved_source_preset_v1(jsonb),
  security_private.withdraw_zagulyaka_v1(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.admin_list_zagulyaky_claims_v1(text, integer, integer),
  security_private.admin_list_zagulyaky_queue_v1(text, integer, integer),
  security_private.admin_review_zagulyaka_v1(uuid, integer, text, text, text, text, text),
  security_private.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text),
  security_private.confirm_zagulyaka_v1(uuid, text, text),
  security_private.create_zagulyaka_claim_v1(uuid, text, text),
  security_private.create_zagulyaka_draft_v1(text, jsonb),
  security_private.delete_my_zagulyaka_attachment_v2(uuid, uuid, integer),
  security_private.delete_my_zagulyaka_draft_v3(uuid, integer),
  security_private.delete_my_zagulyaky_saved_place_v1(uuid),
  security_private.delete_my_zagulyaky_saved_source_preset_v1(uuid),
  security_private.get_my_zagulyaka_draft_v1(uuid),
  security_private.get_my_zagulyaky_page_v1(text, integer, integer),
  security_private.get_my_zagulyaky_v1(text, integer, integer),
  security_private.list_my_zagulyaky_saved_places_v1(text, integer),
  security_private.list_my_zagulyaky_saved_source_presets_v1(text, integer),
  security_private.replace_my_zagulyaka_details_v1(uuid, integer, jsonb, jsonb, jsonb),
  security_private.set_zagulyaka_bookmark_v1(uuid, boolean),
  security_private.submit_zagulyaka_v1(uuid, integer),
  security_private.update_my_zagulyaka_draft_v1(uuid, integer, jsonb),
  security_private.upsert_my_zagulyaky_saved_place_v1(jsonb),
  security_private.upsert_my_zagulyaky_saved_source_preset_v1(jsonb),
  security_private.withdraw_zagulyaka_v1(uuid, integer)
  to authenticated, service_role;

revoke all on function
  public.get_public_zagulyaka_v1(text),
  public.get_zagulyaky_public_stats_v1(),
  public.search_zagulyaky_documents_v1(text, jsonb, integer, timestamptz, uuid),
  public.search_zagulyaky_people_v1(text, jsonb, integer, timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.get_public_zagulyaka_v1(text),
  public.get_zagulyaky_public_stats_v1(),
  public.search_zagulyaky_documents_v1(text, jsonb, integer, timestamptz, uuid),
  public.search_zagulyaky_people_v1(text, jsonb, integer, timestamptz, uuid)
  to anon, authenticated, service_role;

revoke all on function
  public.admin_list_zagulyaky_claims_v1(text, integer, integer),
  public.admin_list_zagulyaky_queue_v1(text, integer, integer),
  public.admin_review_zagulyaka_v1(uuid, integer, text, text, text, text, text),
  public.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text),
  public.confirm_zagulyaka_v1(uuid, text, text),
  public.create_zagulyaka_claim_v1(uuid, text, text),
  public.create_zagulyaka_draft_v1(text, jsonb),
  public.delete_my_zagulyaka_attachment_v2(uuid, uuid, integer),
  public.delete_my_zagulyaka_draft_v3(uuid, integer),
  public.delete_my_zagulyaky_saved_place_v1(uuid),
  public.delete_my_zagulyaky_saved_source_preset_v1(uuid),
  public.get_my_zagulyaka_draft_v1(uuid),
  public.get_my_zagulyaky_page_v1(text, integer, integer),
  public.get_my_zagulyaky_v1(text, integer, integer),
  public.list_my_zagulyaky_saved_places_v1(text, integer),
  public.list_my_zagulyaky_saved_source_presets_v1(text, integer),
  public.replace_my_zagulyaka_details_v1(uuid, integer, jsonb, jsonb, jsonb),
  public.set_zagulyaka_bookmark_v1(uuid, boolean),
  public.submit_zagulyaka_v1(uuid, integer),
  public.update_my_zagulyaka_draft_v1(uuid, integer, jsonb),
  public.upsert_my_zagulyaky_saved_place_v1(jsonb),
  public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb),
  public.withdraw_zagulyaka_v1(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.admin_list_zagulyaky_claims_v1(text, integer, integer),
  public.admin_list_zagulyaky_queue_v1(text, integer, integer),
  public.admin_review_zagulyaka_v1(uuid, integer, text, text, text, text, text),
  public.attach_my_zagulyaka_file_v1(uuid, integer, text, text, text, bigint, text),
  public.confirm_zagulyaka_v1(uuid, text, text),
  public.create_zagulyaka_claim_v1(uuid, text, text),
  public.create_zagulyaka_draft_v1(text, jsonb),
  public.delete_my_zagulyaka_attachment_v2(uuid, uuid, integer),
  public.delete_my_zagulyaka_draft_v3(uuid, integer),
  public.delete_my_zagulyaky_saved_place_v1(uuid),
  public.delete_my_zagulyaky_saved_source_preset_v1(uuid),
  public.get_my_zagulyaka_draft_v1(uuid),
  public.get_my_zagulyaky_page_v1(text, integer, integer),
  public.get_my_zagulyaky_v1(text, integer, integer),
  public.list_my_zagulyaky_saved_places_v1(text, integer),
  public.list_my_zagulyaky_saved_source_presets_v1(text, integer),
  public.replace_my_zagulyaka_details_v1(uuid, integer, jsonb, jsonb, jsonb),
  public.set_zagulyaka_bookmark_v1(uuid, boolean),
  public.submit_zagulyaka_v1(uuid, integer),
  public.update_my_zagulyaka_draft_v1(uuid, integer, jsonb),
  public.upsert_my_zagulyaky_saved_place_v1(jsonb),
  public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb),
  public.withdraw_zagulyaka_v1(uuid, integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
