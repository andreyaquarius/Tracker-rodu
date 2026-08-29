begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(28);

select has_table('public', 'feedback_threads', 'feedback threads table exists');
select has_table('public', 'feedback_messages', 'feedback messages table exists');
select has_function('public', 'create_feedback_thread', array['text', 'text', 'text'], 'thread creation RPC exists');
select has_function('public', 'post_feedback_message', array['uuid', 'text'], 'message RPC exists');
select has_function('public', 'list_feedback_threads', array[]::text[], 'thread list RPC exists');
select has_function('public', 'list_feedback_messages', array['uuid'], 'message list RPC exists');
select has_function('public', 'mark_feedback_thread_read', array['uuid'], 'read marker RPC exists');
select has_function('public', 'set_feedback_thread_status', array['uuid', 'text'], 'status RPC exists');
select has_function('public', 'get_feedback_unread_count', array[]::text[], 'unread counter RPC exists');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'fb000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'feedback-author@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fb000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'feedback-stranger@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fb000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated', 'feedback-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('fb000000-0000-0000-0000-000000000001', 'feedback-author@example.test', 'Feedback Author'),
  ('fb000000-0000-0000-0000-000000000002', 'feedback-stranger@example.test', 'Feedback Stranger'),
  ('fb000000-0000-0000-0000-000000000003', 'feedback-admin@example.test', 'Feedback Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values (
  'fb000000-0000-0000-0000-000000000003',
  'fb000000-0000-0000-0000-000000000003'
) on conflict (user_id) do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb000000-0000-0000-0000-000000000001","role":"authenticated","email":"feedback-author@example.test"}',
  true
);

create temporary table feedback_test_state (
  thread_id uuid primary key
) on commit drop;

insert into feedback_test_state (thread_id)
select public.create_feedback_thread(
  'Приватне тестове звернення',
  'question',
  'Це повідомлення має бачити лише автор та адміністратор.'
);

select is(jsonb_array_length(public.list_feedback_threads()), 1, 'author sees own thread');
select is(
  public.list_feedback_threads() -> 0 ->> 'authorEmail',
  'feedback-author@example.test',
  'author sees own account metadata'
);
select is(
  jsonb_array_length(public.list_feedback_messages((select thread_id from feedback_test_state))),
  1,
  'author sees own first message'
);
select is(public.get_feedback_unread_count(), 0, 'author has no unread reply initially');

select set_config(
  'request.jwt.claims',
  '{"sub":"fb000000-0000-0000-0000-000000000002","role":"authenticated","email":"feedback-stranger@example.test"}',
  true
);

select is(jsonb_array_length(public.list_feedback_threads()), 0, 'another user cannot list the thread');
select is(
  (select count(*)::integer from public.feedback_threads),
  0,
  'RLS hides the thread from another user'
);
select is(
  (select count(*)::integer from public.feedback_messages),
  0,
  'RLS hides messages from another user'
);
select throws_ok(
  format(
    'select public.list_feedback_messages(%L::uuid)',
    (select thread_id from feedback_test_state)
  ),
  'P0002',
  'FEEDBACK_THREAD_NOT_FOUND',
  'another user cannot list messages through RPC'
);
select throws_ok(
  format(
    'select public.post_feedback_message(%L::uuid, %L)',
    (select thread_id from feedback_test_state),
    'Unauthorized reply'
  ),
  '42501',
  'FEEDBACK_ACCESS_DENIED',
  'another user cannot reply through RPC'
);
select throws_ok(
  format(
    'select public.set_feedback_thread_status(%L::uuid, %L)',
    (select thread_id from feedback_test_state),
    'closed'
  ),
  'P0002',
  'FEEDBACK_THREAD_NOT_FOUND',
  'another user cannot change status through RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fb000000-0000-0000-0000-000000000003","role":"authenticated","email":"feedback-admin@example.test"}',
  true
);

select is(jsonb_array_length(public.list_feedback_threads()), 1, 'administrator sees the private thread');
select is(public.get_feedback_unread_count(), 1, 'administrator sees an unread user message');
select public.mark_feedback_thread_read((select thread_id from feedback_test_state));
select is(public.get_feedback_unread_count(), 0, 'administrator can mark the thread read');

-- pgTAP runs this scenario in one transaction, where now() is stable. Move
-- the author's marker into the past to model the next real PostgREST request.
reset role;
update public.feedback_threads
set author_last_read_at = now() - interval '1 second'
where id = (select thread_id from feedback_test_state);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb000000-0000-0000-0000-000000000003","role":"authenticated","email":"feedback-admin@example.test"}',
  true
);

select lives_ok(
  format(
    'select public.post_feedback_message(%L::uuid, %L)',
    (select thread_id from feedback_test_state),
    'Private administrator response'
  ),
  'administrator can reply'
);
select is(
  public.list_feedback_threads() -> 0 ->> 'status',
  'answered',
  'administrator reply updates the thread status'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fb000000-0000-0000-0000-000000000001","role":"authenticated","email":"feedback-author@example.test"}',
  true
);

select is(public.get_feedback_unread_count(), 1, 'author sees the administrator reply as unread');
select is(
  jsonb_array_length(public.list_feedback_messages((select thread_id from feedback_test_state))),
  2,
  'author sees the complete private conversation'
);
select public.mark_feedback_thread_read((select thread_id from feedback_test_state));
select is(public.get_feedback_unread_count(), 0, 'author can mark the reply read');

reset role;
select ok(
  not has_table_privilege('authenticated', 'public.feedback_threads', 'INSERT')
  and not has_table_privilege('authenticated', 'public.feedback_threads', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.feedback_threads', 'DELETE')
  and not has_table_privilege('authenticated', 'public.feedback_messages', 'INSERT')
  and not has_table_privilege('authenticated', 'public.feedback_messages', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.feedback_messages', 'DELETE'),
  'authenticated clients have no direct write privileges'
);

select * from finish();
rollback;
