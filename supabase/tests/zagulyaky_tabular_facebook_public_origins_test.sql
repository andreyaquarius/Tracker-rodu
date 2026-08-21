begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(20);

select has_table(
  'public',
  'zagulyaky_tabular_import_record_origins',
  'tabular Facebook provenance has a protected per-record mapping'
);
select has_column(
  'public',
  'zagulyaky_tabular_import_record_origins',
  'public_link_status',
  'the map has an explicit public-link state'
);
select ok(
  (select relrowsecurity
   from pg_class
   where oid = 'public.zagulyaky_tabular_import_record_origins'::regclass),
  'the per-record provenance map has RLS enabled'
);
select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_tabular_import_record_origins', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_tabular_import_record_origins', 'INSERT')
  and has_table_privilege('service_role', 'public.zagulyaky_tabular_import_record_origins', 'SELECT'),
  'browser roles cannot read or write the private Facebook provenance map'
);
select has_function(
  'public',
  'admin_set_zagulyaka_tabular_facebook_origin_visibility_v1',
  array['uuid[]', 'boolean'],
  'the bounded explicit-visibility admin facade exists'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)'::regprocedure,
    'EXECUTE'
  ),
  'the explicit visibility switch is not an anonymous public API'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '9b000000-0000-0000-0000-000000000029',
  'authenticated', 'authenticated', 'tabular-origin-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles (user_id, email, display_name) values
  ('9b000000-0000-0000-0000-000000000029', 'tabular-origin-admin@example.test', 'Tabular Origin Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values
  ('9b000000-0000-0000-0000-000000000029', '9b000000-0000-0000-0000-000000000029')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by) values
  ('9b000000-0000-0000-0000-000000000029', 'content_admin', '9b000000-0000-0000-0000-000000000029')
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_tabular_import_batches (
  id, source_file_name, source_checksum, import_mode, status, requested_by
) values (
  '9c000000-0000-4000-8000-000000000029',
  'pgtap-tabular-facebook-origin.xlsx', repeat('c', 64), 'commit', 'completed',
  '9b000000-0000-0000-0000-000000000029'
);

insert into public.zagulyaky_tabular_import_source_posts (
  id, batch_id, post_key, source_platform, facebook_post_url_private, post_original_text
) values
  (
    '9d000000-0000-4000-8000-000000000029',
    '9c000000-0000-4000-8000-000000000029',
    'pgtap-public-origin-post', 'facebook',
    'https://www.facebook.com/groups/example/posts/pgtap-public-origin',
    'Private source text must remain private.'
  ),
  (
    '9d000000-0000-4000-8000-000000000030',
    '9c000000-0000-4000-8000-000000000029',
    'pgtap-non-facebook-url', 'other',
    'https://example.test/not-a-facebook-post',
    'A non-Facebook value remains private and non-publishable.'
  );

insert into public.zagulyaky_tabular_import_cards (
  id, batch_id, card_key, post_key, event_key, card_sequence,
  card_kind, primary_participant_key, card_title_original
) values
  (
    '9e000000-0000-4000-8000-000000000029',
    '9c000000-0000-4000-8000-000000000029',
    'pgtap-public-origin-card', 'pgtap-public-origin-post', 'pgtap-public-origin-event', 1,
    'person', 'pgtap-public-origin-participant', 'Тестова загуляка з Facebook'
  ),
  (
    '9e000000-0000-4000-8000-000000000030',
    '9c000000-0000-4000-8000-000000000029',
    'pgtap-non-facebook-card', 'pgtap-non-facebook-url', 'pgtap-non-facebook-event', 2,
    'person', 'pgtap-non-facebook-participant', 'Непублічний зовнішній URL'
  );

insert into public.zagulyaky_records (
  id, kind, status, privacy_status, title, created_by
) values
  (
    '9f000000-0000-4000-8000-000000000029',
    'person', 'draft', 'pending', 'Тестова загуляка з Facebook',
    '9b000000-0000-0000-0000-000000000029'
  ),
  (
    '9f000000-0000-4000-8000-000000000030',
    'person', 'draft', 'pending', 'Непублічний зовнішній URL',
    '9b000000-0000-0000-0000-000000000029'
  );

insert into public.zagulyaky_tabular_import_card_records(card_id, record_id, batch_id) values
  (
    '9e000000-0000-4000-8000-000000000029',
    '9f000000-0000-4000-8000-000000000029',
    '9c000000-0000-4000-8000-000000000029'
  ),
  (
    '9e000000-0000-4000-8000-000000000030',
    '9f000000-0000-4000-8000-000000000030',
    '9c000000-0000-4000-8000-000000000029'
  );

select ok(
  exists (
    select 1
    from public.zagulyaky_tabular_import_record_origins origin_row
    where origin_row.record_id = '9f000000-0000-4000-8000-000000000029'
      and origin_row.public_link_status = 'private'
      and origin_row.source_id is null
  ),
  'a new valid Facebook-backed tabular card receives private-only provenance'
);
select is(
  (select count(*)::integer
   from public.zagulyaky_tabular_import_record_origins origin_row
   where origin_row.record_id = '9f000000-0000-4000-8000-000000000030'),
  0,
  'a non-Facebook URL is not captured as a Facebook publishable origin'
);
select is(
  (select count(*)::integer
   from public.zagulyaky_record_sources link
   where link.record_id = '9f000000-0000-4000-8000-000000000029'),
  0,
  'capturing private provenance creates no catalogue source automatically'
);

update public.zagulyaky_records
set status = 'published',
    privacy_status = 'cleared',
    public_slug = 'pgtap-public-origin',
    published_at = now()
where id = '9f000000-0000-4000-8000-000000000029';

select ok(
  not (coalesce(public.get_public_zagulyaka_v1('pgtap-public-origin'), '{}'::jsonb) ? 'originalPostUrl'),
  'published and cleared alone does not expose an unapproved Facebook link'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9b000000-0000-0000-0000-000000000029","role":"authenticated","email":"tabular-origin-admin@example.test"}',
  true
);

create temporary table pgtap_origin_enable as
select public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
  array['9f000000-0000-4000-8000-000000000029'::uuid],
  true
) as result;

create temporary table pgtap_non_facebook_origin_enable as
select public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
  array['9f000000-0000-4000-8000-000000000030'::uuid],
  true
) as result;

reset role;

select ok(
  (select (result ->> 'approvedCount')::integer from pgtap_origin_enable) = 1
  and (select (result ->> 'missingOriginCount')::integer from pgtap_origin_enable) = 0
  and (select result::text from pgtap_origin_enable) not like '%facebook.com/groups/example/posts/pgtap-public-origin%',
  'explicit approval returns aggregate counts only, never the private URL'
);
select ok(
  (select (result ->> 'mappedCount')::integer from pgtap_non_facebook_origin_enable) = 0
  and (select (result ->> 'missingOriginCount')::integer from pgtap_non_facebook_origin_enable) = 1
  and (select result::text from pgtap_non_facebook_origin_enable) not like '%example.test/not-a-facebook-post%',
  'a non-Facebook source remains excluded and is reported only as an aggregate count'
);
select ok(
  exists (
    select 1
    from public.zagulyaky_tabular_import_record_origins origin_row
    where origin_row.record_id = '9f000000-0000-4000-8000-000000000029'
      and origin_row.public_link_status = 'approved'
      and origin_row.source_id is not null
  ),
  'explicit approval marks the private map approved and links its source'
);
select ok(
  exists (
    select 1
    from public.zagulyaky_tabular_import_record_origins origin_row
    join public.zagulyaky_sources source_row on source_row.id = origin_row.source_id
    join public.zagulyaky_record_sources record_source
      on record_source.record_id = origin_row.record_id
      and record_source.source_id = source_row.id
    where origin_row.record_id = '9f000000-0000-4000-8000-000000000029'
      and source_row.source_type = 'social_post'
      and source_row.source_platform = 'facebook'
      and source_row.permission_status = 'link_only'
      and source_row.source_url = 'https://www.facebook.com/groups/example/posts/pgtap-public-origin'
  ),
  'approval creates only the minimal linked social-post source projection'
);
select is(
  public.get_public_zagulyaka_v1('pgtap-public-origin') ->> 'originalPostUrl',
  'https://www.facebook.com/groups/example/posts/pgtap-public-origin',
  'the public detail contract emits the approved Facebook link for an eligible record'
);
select ok(
  coalesce(public.search_zagulyaky_people_v1(
    'Тестова загуляка з Facebook', '{}'::jsonb, 20, null, null
  )::text, '') not like '%facebook.com/groups/example/posts/pgtap-public-origin%',
  'public search never emits the original Facebook URL'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9b000000-0000-0000-0000-000000000029","role":"authenticated","email":"tabular-origin-admin@example.test"}',
  true
);

create temporary table pgtap_origin_revoke as
select public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
  array['9f000000-0000-4000-8000-000000000029'::uuid],
  false
) as result;

reset role;

select ok(
  (select (result ->> 'revokedCount')::integer from pgtap_origin_revoke) = 1
  and (select result::text from pgtap_origin_revoke) not like '%facebook.com/groups/example/posts/pgtap-public-origin%',
  'revocation is explicit, aggregate-only, and does not echo the link'
);
select ok(
  exists (
    select 1
    from public.zagulyaky_tabular_import_record_origins origin_row
    where origin_row.record_id = '9f000000-0000-4000-8000-000000000029'
      and origin_row.public_link_status = 'revoked'
      and origin_row.source_id is null
  ),
  'revocation removes the linked public-source relation'
);
select ok(
  not (coalesce(public.get_public_zagulyaka_v1('pgtap-public-origin'), '{}'::jsonb) ? 'originalPostUrl'),
  'the public detail contract stops emitting the link immediately after revocation'
);
select ok(
  not exists (
    select 1
    from public.admin_audit_log audit_row
    where audit_row.target_type = 'zagulyaky_tabular_facebook_origins'
      and audit_row.sanitized_diff::text like '%facebook.com/groups/example/posts/pgtap-public-origin%'
  ),
  'origin-link audit entries are sanitized and never retain the raw URL'
);

select * from finish();
rollback;
