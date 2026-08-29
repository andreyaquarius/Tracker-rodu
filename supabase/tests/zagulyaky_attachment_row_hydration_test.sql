begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

select has_function(
  'public',
  'admin_get_zagulyaka_attachment_review_v1',
  array['uuid'],
  'moderator attachment preview facade exists'
);
select has_function(
  'public',
  'admin_prepare_zagulyaka_attachment_publication_v2',
  array['uuid'],
  'durable attachment publication prepare facade exists'
);
select has_function(
  'public',
  'admin_complete_zagulyaka_attachment_publication_v2',
  array['uuid', 'text'],
  'durable attachment publication complete facade exists'
);
select has_function(
  'public',
  'admin_revoke_zagulyaka_attachment_publication_v2',
  array['uuid'],
  'durable attachment publication revoke facade exists'
);

select is(
  (
    select count(*)
    from unnest(array[
      'security_private.admin_get_zagulyaka_attachment_review_v1(uuid)',
      'security_private.admin_prepare_zagulyaka_attachment_publication_v1(uuid)',
      'security_private.admin_complete_zagulyaka_attachment_publication_v1(uuid,text)',
      'security_private.admin_revoke_zagulyaka_attachment_publication_v1(uuid)',
      'security_private.admin_prepare_zagulyaka_attachment_publication_v2(uuid)',
      'security_private.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)',
      'security_private.admin_revoke_zagulyaka_attachment_publication_v2(uuid)'
    ]) signature
    join pg_proc function_record on function_record.oid = to_regprocedure(signature)
    where position('select a.* into attachment' in function_record.prosrc) > 0
      and position('select r.* into target_record' in function_record.prosrc) > 0
      and position('select a into attachment' in function_record.prosrc) = 0
      and position('select r into target_record' in function_record.prosrc) = 0
  ),
  7::bigint,
  'all attachment workflows hydrate both typed rows from expanded whole rows'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '8b000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'attachment-author@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '8b000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'attachment-moderator@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('8b000000-0000-4000-8000-000000000001', 'attachment-author@example.test', 'Attachment Author'),
  ('8b000000-0000-4000-8000-000000000002', 'attachment-moderator@example.test', 'Attachment Moderator')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by)
values ('8b000000-0000-4000-8000-000000000002', '8b000000-0000-4000-8000-000000000002')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by)
values (
  '8b000000-0000-4000-8000-000000000002',
  'content_admin',
  '8b000000-0000-4000-8000-000000000002'
)
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_records (
  id, kind, status, verification_status, privacy_status, public_slug, title,
  created_by, submitted_at, published_at, moderated_by
) values (
  '8b100000-0000-4000-8000-000000000001',
  'person',
  'published',
  'verified',
  'cleared',
  'attachment-row-hydration-test',
  'Тестова загуляка з приватним вкладенням',
  '8b000000-0000-4000-8000-000000000001',
  now(),
  now(),
  '8b000000-0000-4000-8000-000000000002'
);

insert into public.zagulyaky_attachments (
  id, record_id, storage_bucket, storage_path, file_name, mime_type,
  byte_size, sha256, is_public_derivative, created_by
) values (
  '8b200000-0000-4000-8000-000000000001',
  '8b100000-0000-4000-8000-000000000001',
  'zagulyaky-private',
  '8b000000-0000-4000-8000-000000000001/8b100000-0000-4000-8000-000000000001/test.png',
  'test.png',
  'image/png',
  256,
  repeat('a', 64),
  false,
  '8b000000-0000-4000-8000-000000000001'
);

create temporary table zagulyaky_attachment_row_hydration_state (
  public_path text not null
) on commit drop;

grant select, insert, update, delete on zagulyaky_attachment_row_hydration_state to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-000000000002","role":"authenticated","email":"attachment-moderator@example.test"}',
  true
);

select is(
  public.admin_get_zagulyaka_attachment_review_v1(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'attachmentId',
  '8b200000-0000-4000-8000-000000000001',
  'moderator preview returns the attachment id without 22P02'
);

select is(
  public.admin_get_zagulyaka_attachment_review_v1(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'recordId',
  '8b100000-0000-4000-8000-000000000001',
  'moderator preview hydrates the parent record row'
);

select is(
  public.admin_get_zagulyaka_attachment_review_v1(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'privatePath',
  '8b000000-0000-4000-8000-000000000001/8b100000-0000-4000-8000-000000000001/test.png',
  'moderator preview exposes the expected private path to the trusted Edge function'
);

insert into zagulyaky_attachment_row_hydration_state(public_path)
select public.admin_prepare_zagulyaka_attachment_publication_v2(
  '8b200000-0000-4000-8000-000000000001'
) ->> 'publicPath';

select is(
  public.admin_prepare_zagulyaka_attachment_publication_v2(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'attachmentId',
  '8b200000-0000-4000-8000-000000000001',
  'publication prepare returns the attachment id without 22P02'
);

select ok(
  (
    select public_path ~
      '^catalogue/8b100000-0000-4000-8000-000000000001/8b200000-0000-4000-8000-000000000001/[0-9a-f-]{36}/test[.]png$'
    from zagulyaky_attachment_row_hydration_state
  ),
  'publication prepare allocates a generation-scoped public path'
);

select is(
  public.admin_prepare_zagulyaka_attachment_publication_v2(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'targetExists',
  'false',
  'publication prepare reports that the Edge function still needs to copy the object'
);

reset role;

insert into storage.objects (bucket_id, name, owner, metadata)
select
  'zagulyaky-public',
  public_path,
  '8b000000-0000-4000-8000-000000000002',
  '{"mimetype":"image/png","size":256}'::jsonb
from zagulyaky_attachment_row_hydration_state;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-4000-8000-000000000002","role":"authenticated","email":"attachment-moderator@example.test"}',
  true
);

select is(
  public.admin_complete_zagulyaka_attachment_publication_v2(
    '8b200000-0000-4000-8000-000000000001',
    (select public_path from zagulyaky_attachment_row_hydration_state)
  ) ->> 'alreadyPublished',
  'false',
  'publication complete accepts the copied public object without 22P02'
);

-- Browser roles intentionally have no direct table ACLs. Inspect the durable
-- state as the test owner after exercising the public RPC as authenticated.
reset role;

select ok(
  exists (
    select 1
    from public.zagulyaky_attachments attachment
    where attachment.id = '8b200000-0000-4000-8000-000000000001'
      and attachment.is_public_derivative
      and attachment.public_bucket = 'zagulyaky-public'
      and attachment.public_path = (
        select public_path from zagulyaky_attachment_row_hydration_state
      )
  ),
  'publication complete stores the public derivative metadata'
);

set local role authenticated;

select is(
  public.admin_revoke_zagulyaka_attachment_publication_v2(
    '8b200000-0000-4000-8000-000000000001'
  ) ->> 'alreadyRevoked',
  'false',
  'publication revoke queues cleanup without 22P02'
);

reset role;

select ok(
  exists (
    select 1
    from public.zagulyaky_attachments attachment
    where attachment.id = '8b200000-0000-4000-8000-000000000001'
      and not attachment.is_public_derivative
      and attachment.public_bucket is null
      and attachment.public_path is null
      and attachment.public_derivative_generation is null
  ),
  'publication revoke clears all public derivative metadata'
);

select ok(
  exists (
    select 1
    from public.zagulyaky_storage_cleanup_queue cleanup_task
    where cleanup_task.source_attachment_id = '8b200000-0000-4000-8000-000000000001'
      and cleanup_task.storage_bucket = 'zagulyaky-public'
      and cleanup_task.storage_path = (
        select public_path from zagulyaky_attachment_row_hydration_state
      )
      and cleanup_task.status = 'queued'
  ),
  'publication revoke durably queues the former public object for deletion'
);

reset role;
select * from finish();
rollback;
