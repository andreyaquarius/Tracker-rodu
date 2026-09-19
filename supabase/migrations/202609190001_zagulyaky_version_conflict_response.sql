begin;

-- A stale application lock_version cannot succeed by replaying the same RPC.
-- SQLSTATE 40001 means a retryable database serialization failure; some
-- PostgREST/Hasql versions retry it inside the server, before the browser's
-- circuit breaker can see a response. Translate ONLY our business conflict
-- at the API boundary into HTTP 409, keeping the error marker for old clients.
-- The exception block rolls back the failed call. Real serialization errors
-- and all ownership, moderation, privacy and validation checks stay intact.
-- CREATE OR REPLACE preserves the existing function owners and EXECUTE ACLs
-- (archival publication deliberately has no service_role grant).

-- Fail closed on a partially migrated installation: replacing existing RPCs
-- preserves their ACLs, but creating a missing one would default to PUBLIC.
do $existing_facades$
declare
  signature text;
begin
  foreach signature in array array[
    'public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb)',
    'public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)',
    'public.submit_zagulyaka_v1(uuid,integer)',
    'public.withdraw_zagulyaka_v1(uuid,integer)',
    'public.attach_my_zagulyaka_file_v1(uuid,integer,text,text,text,bigint,text)',
    'public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)',
    'public.delete_my_zagulyaka_draft_v3(uuid,integer)',
    'public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text)',
    'public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)',
    'public.admin_publish_archival_zagulyaka_v1(uuid,integer,uuid,text,text,text)'
  ] loop
    if pg_catalog.to_regprocedure(signature) is null then
      raise exception 'Missing required Zagulyaky facade: %', signature using errcode = '42883';
    end if;
  end loop;
end;
$existing_facades$;

create or replace function public.update_my_zagulyaka_draft_v1(
  p_record_id uuid, p_expected_lock_version integer, p_patch jsonb
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.update_my_zagulyaka_draft_v1($1, $2, $3);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.replace_my_zagulyaka_details_v1(
  p_record_id uuid, p_expected_lock_version integer,
  p_sources jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_document_discoveries jsonb default '[]'::jsonb
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.replace_my_zagulyaka_details_v1($1, $2, $3, $4, $5);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.submit_zagulyaka_v1(
  p_record_id uuid, p_expected_lock_version integer
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.submit_zagulyaka_v1($1, $2);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.withdraw_zagulyaka_v1(
  p_record_id uuid, p_expected_lock_version integer
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.withdraw_zagulyaka_v1($1, $2);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.attach_my_zagulyaka_file_v1(
  p_record_id uuid, p_expected_lock_version integer, p_storage_path text,
  p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256 text
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.attach_my_zagulyaka_file_v1($1, $2, $3, $4, $5, $6, $7);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.delete_my_zagulyaka_attachment_v2(
  p_record_id uuid, p_attachment_id uuid, p_expected_lock_version integer
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.delete_my_zagulyaka_attachment_v2($1, $2, $3);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.delete_my_zagulyaka_draft_v3(
  p_record_id uuid, p_expected_lock_version integer
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.delete_my_zagulyaka_draft_v3($1, $2);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.admin_review_zagulyaka_v1(
  p_record_id uuid, p_expected_lock_version integer, p_action text,
  p_note text default '', p_verification_status text default null,
  p_privacy_status text default null, p_public_slug text default null
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.admin_review_zagulyaka_v1($1, $2, $3, $4, $5, $6, $7);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.admin_merge_zagulyaka_duplicate_v1(
  p_survivor_record_id uuid, p_merged_record_id uuid,
  p_survivor_expected_lock_version integer, p_merged_expected_lock_version integer,
  p_note text
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.admin_merge_zagulyaka_duplicate_v1($1, $2, $3, $4, $5);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

create or replace function public.admin_publish_archival_zagulyaka_v1(
  p_record_id uuid, p_expected_lock_version integer, p_source_id uuid,
  p_note text default '', p_verification_status text default null,
  p_public_slug text default null
)
returns jsonb language plpgsql volatile security invoker
set search_path = pg_catalog
as $wrapper$
begin
  return security_private.admin_publish_archival_zagulyaka_v1($1, $2, $3, $4, $5, $6);
exception when sqlstate '40001' then
  if sqlerrm = 'ZAGULYAKA_VERSION_CONFLICT' then
    raise sqlstate 'PT409' using message = 'ZAGULYAKA_VERSION_CONFLICT',
      hint = 'Reload the record before retrying. Do not retry the stale version.';
  end if;
  raise;
end;
$wrapper$;

notify pgrst, 'reload schema';
commit;
