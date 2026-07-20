begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(101);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'tariff-free@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'tariff-researcher@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'tariff-trial@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 'tariff-editor-one@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000013', 'authenticated', 'authenticated', 'tariff-editor-three@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'aa000000-0000-0000-0000-000000000021', 'authenticated', 'authenticated', 'tariff-viewer@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

update public.user_subscriptions subscription
set plan_id = plan.id,
    status = 'active',
    current_period_start = now(),
    current_period_end = now() + interval '1 month',
    trial_started_at = null,
    trial_ends_at = null
from public.subscription_plans plan
where plan.code = 'free'
  and subscription.user_id in (
    'aa000000-0000-0000-0000-000000000001'::uuid,
    'aa000000-0000-0000-0000-000000000011'::uuid,
    'aa000000-0000-0000-0000-000000000013'::uuid,
    'aa000000-0000-0000-0000-000000000021'::uuid
  );

update public.user_subscriptions subscription
set plan_id = plan.id,
    status = 'active',
    current_period_start = now(),
    current_period_end = now() + interval '1 month',
    trial_started_at = null,
    trial_ends_at = null
from public.subscription_plans plan
where plan.code = 'researcher'
  and subscription.user_id = 'aa000000-0000-0000-0000-000000000002'::uuid;

insert into public.projects (id, owner_id, name) values
  ('bb000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 'Free tariff project'),
  ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000002', 'Researcher tariff project one'),
  ('bb000000-0000-0000-0000-000000000003', 'aa000000-0000-0000-0000-000000000002', 'Researcher tariff project two');

select throws_ok(
  $$update public.projects set owner_id = 'aa000000-0000-0000-0000-000000000011' where id = 'bb000000-0000-0000-0000-000000000001'$$,
  '0A000',
  'PROJECT_OWNER_TRANSFER_NOT_SUPPORTED',
  'project ownership cannot bypass account-wide capacity counters'
);

select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000001') where limit_key = 'persons_total'$$,
  $$values (500, false)$$,
  'Free has 500 people'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000001') where limit_key = 'family_trees_total'$$,
  $$values (1, false)$$,
  'Free has one tree'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000001') where limit_key = 'editors_total'$$,
  $$values (0, false)$$,
  'Free has no paid editor seat'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000002') where limit_key = 'persons_total'$$,
  $$values (15000, false)$$,
  'Researcher has 15,000 people'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000002') where limit_key = 'family_trees_total'$$,
  $$values (null::integer, true)$$,
  'Researcher trees are not tariff limited'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000002') where limit_key = 'editors_total'$$,
  $$values (2, false)$$,
  'Researcher has two distinct editor seats'
);
select results_eq(
  $$select limit_value, is_unlimited from public.plan_limits limits join public.subscription_plans plan on plan.id = limits.plan_id where plan.code = 'professional' and limit_key = 'persons_total'$$,
  $$values (null::integer, true)$$,
  'Professional people are not tariff limited'
);
select results_eq(
  $$select limit_value, is_unlimited from public.plan_limits limits join public.subscription_plans plan on plan.id = limits.plan_id where plan.code = 'professional' and limit_key = 'family_trees_total'$$,
  $$values (null::integer, true)$$,
  'Professional trees are not tariff limited'
);
select results_eq(
  $$select limit_value, is_unlimited from public.plan_limits limits join public.subscription_plans plan on plan.id = limits.plan_id where plan.code = 'professional' and limit_key = 'editors_total'$$,
  $$values (5, false)$$,
  'Professional has five editor seats'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000003') where limit_key = 'persons_total'$$,
  $$values (15000, false)$$,
  'Professional trial has a finite 15,000-person limit'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000003') where limit_key = 'editors_total'$$,
  $$values (5, false)$$,
  'Professional trial keeps five editor seats'
);
select results_eq(
  $$select limit_value, is_unlimited from public.get_user_plan_limits('aa000000-0000-0000-0000-000000000003') where limit_key = 'ai_credits_per_month'$$,
  $$values (100, false)$$,
  'Professional trial keeps 100 AI credits'
);

select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values ('bb000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000021', 'viewer', 'aa000000-0000-0000-0000-000000000001')$$,
  'Free can add a viewer despite having zero editor seats'
);
select lives_ok(
  $$insert into public.project_invitations (project_id, email, role, invited_by) values ('bb000000-0000-0000-0000-000000000001', 'another-viewer@example.test', 'viewer', 'aa000000-0000-0000-0000-000000000001')$$,
  'Free can create an unlimited-viewer invitation'
);

-- Keep the integration fixture small while exercising the same server guard.
update public.plan_limits limits
set limit_value = 2
from public.subscription_plans plan
where plan.id = limits.plan_id
  and plan.code = 'free'
  and limits.limit_key = 'persons_total';

select lives_ok(
  $$insert into public.persons (id, project_id, full_name, created_by) values
      ('cc000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000001', 'Free person one', 'aa000000-0000-0000-0000-000000000001'),
      ('cc000000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000001', 'Free person two', 'aa000000-0000-0000-0000-000000000001')$$,
  'Free can fill all available person capacity in one statement'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'persons_total', null),
  2,
  'people are counted account-wide for their project owner'
);
-- The legacy projection stores project_id in child rows without ON UPDATE
-- CASCADE. Remove its generated fixture row so this test can exercise the
-- quota trigger's supported cross-owner transfer path in isolation.
delete from public.person_names
where person_id = 'cc000000-0000-0000-0000-000000000002';
select lives_ok(
  $$update public.persons set project_id = 'bb000000-0000-0000-0000-000000000002' where id = 'cc000000-0000-0000-0000-000000000002'$$,
  'a person can move to a project belonging to another account when both have capacity'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'persons_total', null),
  1,
  'a cross-owner person transfer releases the old owner capacity'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'persons_total', null),
  1,
  'a cross-owner person transfer consumes the new owner capacity'
);
delete from public.person_names
where person_id = 'cc000000-0000-0000-0000-000000000002';
select lives_ok(
  $$update public.persons set project_id = 'bb000000-0000-0000-0000-000000000001' where id = 'cc000000-0000-0000-0000-000000000002'$$,
  'a person can move back without counter drift'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'persons_total', null),
  2,
  'moving a person back restores the original owner usage'
);
select throws_ok(
  $$insert into public.persons (id, project_id, full_name, created_by) values ('cc000000-0000-0000-0000-000000000003', 'bb000000-0000-0000-0000-000000000001', 'Free person over limit', 'aa000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'PLAN_LIMIT_REACHED:persons_total',
  'an insert above the person capacity is rejected atomically'
);
select lives_ok(
  $$update public.persons set full_name = 'Free person one edited' where id = 'cc000000-0000-0000-0000-000000000001'$$,
  'an existing person remains editable at the limit'
);
select lives_ok(
  $$insert into public.family_trees (id, project_id, title, created_by) values ('dd000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000001', 'Free tree', 'aa000000-0000-0000-0000-000000000001')$$,
  'Free can create its first family tree'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'family_trees_total', null),
  1,
  'trees are counted account-wide for their project owner'
);
select lives_ok(
  $$update public.family_trees set project_id = 'bb000000-0000-0000-0000-000000000002' where id = 'dd000000-0000-0000-0000-000000000001'$$,
  'a tree can move to a project belonging to another account when both have capacity'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'family_trees_total', null),
  0,
  'a cross-owner tree transfer releases the old owner capacity'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'family_trees_total', null),
  1,
  'a cross-owner tree transfer consumes the new owner capacity'
);
select lives_ok(
  $$update public.family_trees set project_id = 'bb000000-0000-0000-0000-000000000001' where id = 'dd000000-0000-0000-0000-000000000001'$$,
  'a tree can move back without counter drift'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'family_trees_total', null),
  1,
  'moving a tree back restores the original owner usage'
);
select throws_ok(
  $$insert into public.family_trees (id, project_id, title, created_by) values ('dd000000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000001', 'Second free tree', 'aa000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'PLAN_LIMIT_REACHED:family_trees_total',
  'Free cannot create a second family tree'
);

select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values
      ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000011', 'editor', 'aa000000-0000-0000-0000-000000000002'),
      ('bb000000-0000-0000-0000-000000000003', 'aa000000-0000-0000-0000-000000000011', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'the same editor can join several projects while using one seat'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'one distinct editor across two projects uses one seat'
);

-- Profile email is display metadata and is intentionally mutable. A
-- whitespace lookalike must never merge a different account into editor one.
update public.profiles
set email = ' tariff-editor-one@example.test '
where user_id = 'aa000000-0000-0000-0000-000000000013'::uuid;
select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000013', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'a distinct account cannot merge into another editor through profile whitespace'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'distinct Auth UUIDs consume distinct seats despite colliding profile text'
);
select lives_ok(
  $$delete from public.project_members where project_id = 'bb000000-0000-0000-0000-000000000002' and user_id = 'aa000000-0000-0000-0000-000000000013'$$,
  'the lookalike-profile editor membership can be removed normally'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'removing that distinct account releases exactly its own seat'
);
update public.profiles
set email = 'tariff-editor-three@example.test'
where user_id = 'aa000000-0000-0000-0000-000000000013'::uuid;

-- Changing a member's profile address cannot strand its UUID-keyed registry
-- reference or make the same editor count twice across owned projects.
update public.profiles
set email = 'tariff-editor-one-renamed@example.test'
where user_id = 'aa000000-0000-0000-0000-000000000011'::uuid;
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'profile email changes do not alter UUID-keyed editor usage'
);
select lives_ok(
  $$delete from public.project_members where user_id = 'aa000000-0000-0000-0000-000000000011' and project_id in ('bb000000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000003')$$,
  'all memberships for a renamed editor can be removed'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  0,
  'removing the renamed editor releases the shared seat without drift'
);
select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values
      ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000011', 'editor', 'aa000000-0000-0000-0000-000000000002'),
      ('bb000000-0000-0000-0000-000000000003', 'aa000000-0000-0000-0000-000000000011', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'the renamed editor can rejoin several owned projects'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'the rejoined UUID still consumes one shared editor seat'
);
update public.profiles
set email = 'tariff-editor-one@example.test'
where user_id = 'aa000000-0000-0000-0000-000000000011'::uuid;

select lives_ok(
  $$insert into public.project_invitations (id, project_id, email, role, invited_by) values
      ('ee000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000002', ' TARIFF-EDITOR-TWO@EXAMPLE.TEST ', 'editor', 'aa000000-0000-0000-0000-000000000002'),
      ('ee000000-0000-0000-0000-000000000002', 'bb000000-0000-0000-0000-000000000003', 'tariff-editor-two@example.test', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'pending invitations reserve one distinct case-insensitive editor seat'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'a duplicate pending editor identity is counted only once'
);
select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000021', 'viewer', 'aa000000-0000-0000-0000-000000000002')$$,
  'a viewer does not consume the full Researcher editor pool'
);
select throws_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000013', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'P0001',
  'PLAN_LIMIT_REACHED:editors_total',
  'a third distinct Researcher editor is rejected'
);
select throws_ok(
  $$update public.project_members set role = 'editor' where project_id = 'bb000000-0000-0000-0000-000000000002' and user_id = 'aa000000-0000-0000-0000-000000000021'$$,
  'P0001',
  'PLAN_LIMIT_REACHED:editors_total',
  'viewer-to-editor role changes enforce the same editor capacity'
);
select lives_ok(
  $$update public.project_invitations set status = 'revoked' where id = 'ee000000-0000-0000-0000-000000000001'$$,
  'revoking one duplicate editor invitation succeeds'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'one remaining invitation for the same editor keeps the seat reserved'
);
select lives_ok(
  $$update public.project_invitations set status = 'revoked' where id = 'ee000000-0000-0000-0000-000000000002'$$,
  'revoking the last duplicate editor invitation succeeds'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'revoking the last invitation releases its distinct editor seat'
);
select lives_ok(
  $$insert into public.project_members (project_id, user_id, role, invited_by) values ('bb000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000013', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'a different editor can use the released seat'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'the replacement editor consumes the released seat'
);
select lives_ok(
  $$delete from public.project_members where project_id = 'bb000000-0000-0000-0000-000000000002' and user_id = 'aa000000-0000-0000-0000-000000000013'$$,
  'deleting an editor membership succeeds'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'deleting the editor membership releases the seat'
);
select lives_ok(
  $$update public.project_invitations set status = 'pending' where id = 'ee000000-0000-0000-0000-000000000001'$$,
  'a pending invitation can reserve the released seat again'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'restoring the pending invitation restores the expected editor usage'
);
select lives_ok(
  $$update public.project_invitations set expires_at = now() - interval '1 second' where id = 'ee000000-0000-0000-0000-000000000001'$$,
  'an editor invitation can reach its expiry without a capacity error'
);
select is(
  (select status::text from public.project_invitations where id = 'ee000000-0000-0000-0000-000000000001'),
  'expired',
  'an elapsed pending invitation is normalized to expired'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  1,
  'an expired editor invitation releases its seat'
);
select lives_ok(
  $$update public.project_invitations set expires_at = now() + interval '7 days', status = 'pending' where id = 'ee000000-0000-0000-0000-000000000001'$$,
  'an expired invitation can be renewed when a seat is available'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'renewing the invitation reserves its editor seat again'
);
select lives_ok(
  $$update public.project_invitations set expires_at = now() + interval '7 days', status = 'pending' where id = 'ee000000-0000-0000-0000-000000000002'$$,
  'the same unresolved address can renew an invitation to another owned project'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'duplicate pending invitations still reserve one unresolved-email seat'
);
select lives_ok(
  $$insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000',
      'aa000000-0000-0000-0000-000000000012',
      'authenticated',
      'authenticated',
      'tariff-editor-two@example.test',
      '',
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      now(),
      now()
    )$$,
  'registration atomically upgrades all pending invitations for that address'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'email-to-UUID reconciliation preserves the full editor seat count'
);
select results_eq(
  $$select distinct identity_key from private.subscription_editor_invitation_identities where invitation_id in ('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000002') order by identity_key$$,
  $$values ('user:aa000000-0000-0000-0000-000000000012'::text)$$,
  'all invitations now share the registered user UUID identity'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000012","email":"tariff-editor-two@example.test","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.accept_project_invitation('ee000000-0000-0000-0000-000000000001')$$,
  'accepting a pending editor invitation succeeds at the full seat limit'
);
reset role;
select is(
  (select status::text from public.project_invitations where id = 'ee000000-0000-0000-0000-000000000001'),
  'accepted',
  'acceptance consumes the pending invitation'
);
select ok(
  exists (
    select 1
    from public.project_members member
    where member.project_id = 'bb000000-0000-0000-0000-000000000002'::uuid
      and member.user_id = 'aa000000-0000-0000-0000-000000000012'::uuid
      and member.role = 'editor'
  ),
  'acceptance creates the editor membership'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'invitation-to-membership replacement does not transiently add a seat'
);

select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'membership and pending invitation for one Auth UUID still use one seat'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000012","email":"tariff-editor-two@example.test","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.accept_project_invitation('ee000000-0000-0000-0000-000000000002')$$,
  'the same editor can accept an invitation to a second owned project'
);
reset role;
select ok(
  exists (
    select 1
    from public.project_members member
    where member.project_id = 'bb000000-0000-0000-0000-000000000003'::uuid
      and member.user_id = 'aa000000-0000-0000-0000-000000000012'::uuid
      and member.role = 'editor'
  ),
  'the second invitation creates its project membership'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'one real editor across accepted invitations remains one account seat'
);

insert into private.gedcom_import_operations (
  id,
  project_id,
  requested_by,
  source_key,
  status
) values (
  'ef000000-0000-0000-0000-000000000001',
  'bb000000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'gedcom:tariff-preflight',
  'preparing'
);
insert into private.gedcom_import_operation_entities (
  operation_id,
  project_id,
  entity_type,
  entity_id
) values (
  'ef000000-0000-0000-0000-000000000001',
  'bb000000-0000-0000-0000-000000000001',
  'person',
  'cc000000-0000-0000-0000-000000000099'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","email":"tariff-free@example.test","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.seal_gedcom_import_operation('ef000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'GEDCOM_PERSON_LIMIT_REACHED',
  'GEDCOM person capacity is rejected before its first person insert'
);
reset role;

update public.plan_limits limits
set limit_value = 3
from public.subscription_plans plan
where plan.id = limits.plan_id
  and plan.code = 'free'
  and limits.limit_key = 'persons_total';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","email":"tariff-free@example.test","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.seal_gedcom_import_operation('ef000000-0000-0000-0000-000000000001')$$,
  'P0001',
  'GEDCOM_TREE_LIMIT_REACHED',
  'GEDCOM reserves its new family tree and rejects the import before writes when no tree slot remains'
);
reset role;
select is(
  (select status from private.gedcom_import_operations where id = 'ef000000-0000-0000-0000-000000000001'),
  'preparing',
  'a failed GEDCOM preflight leaves the operation unsealed'
);

delete from private.gedcom_import_operations
where id = 'ef000000-0000-0000-0000-000000000001';
update public.plan_limits limits
set limit_value = 2
from public.subscription_plans plan
where plan.id = limits.plan_id
  and plan.code = 'free'
  and limits.limit_key = 'persons_total';

-- Free one person and one tree slot, then prove that a successful seal keeps
-- those slots reserved and that each persisted GEDCOM row replaces (rather
-- than duplicates) its reservation.
delete from public.family_trees
where id = 'dd000000-0000-0000-0000-000000000001'::uuid;
delete from public.person_names
where person_id = 'cc000000-0000-0000-0000-000000000002'::uuid;
delete from public.persons
where id = 'cc000000-0000-0000-0000-000000000002'::uuid;

insert into private.gedcom_import_operations (
  id,
  project_id,
  requested_by,
  source_key,
  status
) values (
  'ef000000-0000-0000-0000-000000000002',
  'bb000000-0000-0000-0000-000000000001',
  'aa000000-0000-0000-0000-000000000001',
  'gedcom:tariff-reservation-replacement',
  'preparing'
);
insert into private.gedcom_import_operation_entities (
  operation_id,
  project_id,
  entity_type,
  entity_id
) values (
  'ef000000-0000-0000-0000-000000000002',
  'bb000000-0000-0000-0000-000000000001',
  'person',
  'cc000000-0000-0000-0000-000000000098'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","email":"tariff-free@example.test","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.seal_gedcom_import_operation('ef000000-0000-0000-0000-000000000002')$$,
  'GEDCOM seals when its person and tree both fit the remaining capacity'
);
reset role;
select is(
  (select status from private.gedcom_import_operations where id = 'ef000000-0000-0000-0000-000000000002'),
  'importing',
  'a successful GEDCOM preflight moves the operation to importing'
);
select is(
  security_private.owner_person_reservations('aa000000-0000-0000-0000-000000000001'),
  1,
  'the sealed manifest reserves its not-yet-persisted person'
);
select is(
  security_private.owner_tree_reservations('aa000000-0000-0000-0000-000000000001'),
  1,
  'the sealed operation reserves its not-yet-persisted family tree'
);
select lives_ok(
  $$insert into public.persons (id, project_id, full_name, created_by) values ('cc000000-0000-0000-0000-000000000098', 'bb000000-0000-0000-0000-000000000001', 'GEDCOM reserved person', 'aa000000-0000-0000-0000-000000000001')$$,
  'the registered GEDCOM person batch can replace its reservation at the limit'
);
select is(
  security_private.owner_person_reservations('aa000000-0000-0000-0000-000000000001'),
  0,
  'persisting the GEDCOM person consumes its manifest reservation'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'persons_total', null),
  2,
  'persisted person usage reaches the limit without double-counting the reservation'
);
select lives_ok(
  $$insert into public.family_trees (id, project_id, title, settings, created_by, created_at) values ('dd000000-0000-0000-0000-000000000098', 'bb000000-0000-0000-0000-000000000001', 'GEDCOM reserved tree', jsonb_build_object('source', 'gedcom_import', 'rollback_operation_id', 'ef000000-0000-0000-0000-000000000002'), 'aa000000-0000-0000-0000-000000000001', clock_timestamp())$$,
  'the GEDCOM family tree can replace its reserved tree slot at the limit'
);
select is(
  security_private.owner_tree_reservations('aa000000-0000-0000-0000-000000000001'),
  0,
  'persisting the rollback-owned tree consumes the operation tree reservation'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000001', 'family_trees_total', null),
  1,
  'persisted tree usage reaches the limit without double-counting the reservation'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","email":"tariff-free@example.test","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.register_gedcom_import_tree('ef000000-0000-0000-0000-000000000002', 'dd000000-0000-0000-0000-000000000098')$$,
  'the persisted GEDCOM tree is journaled after reservation replacement'
);
reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000011","email":"tariff-editor-one@example.test","role":"authenticated"}',
  true
);
select lives_ok(
  $$select public.begin_ai_credit_usage('bb000000-0000-0000-0000-000000000002', 'hypothesis_review', 1, 0, 0, null, '{}'::jsonb)$$,
  'an editor can use the owner project AI pool'
);
reset role;

select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'ai_credits_per_month', 'bb000000-0000-0000-0000-000000000002'),
  1,
  'the AI credit is billed to the project owner'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000011', 'ai_credits_per_month', 'bb000000-0000-0000-0000-000000000002'),
  0,
  'the acting editor does not spend its personal AI pool'
);
select ok(
  exists (
    select 1
    from public.subscription_events event
    where event.user_id = 'aa000000-0000-0000-0000-000000000002'::uuid
      and event.performed_by = 'aa000000-0000-0000-0000-000000000011'::uuid
      and event.event_type = 'ai_credits_used'
  ),
  'AI audit retains the acting editor while billing the owner'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"aa000000-0000-0000-0000-000000000001","email":"tariff-free@example.test","role":"authenticated"}',
  true
);
select is(
  public.get_my_family_tree_feature_access(),
  true,
  'family tree access is a core authenticated feature without a beta row'
);
reset role;

select lives_ok(
  $$insert into public.persons (id, project_id, full_name, created_by) values ('cc000000-0000-0000-0000-000000000011', 'bb000000-0000-0000-0000-000000000002', 'Researcher existing person', 'aa000000-0000-0000-0000-000000000002')$$,
  'Researcher can create a person before downgrade'
);

update public.user_subscriptions subscription
set plan_id = plan.id,
    status = 'active',
    current_period_start = now(),
    current_period_end = now() + interval '1 month'
from public.subscription_plans plan
where plan.code = 'free'
  and subscription.user_id = 'aa000000-0000-0000-0000-000000000002'::uuid;

select lives_ok(
  $$update public.persons set full_name = 'Researcher person edited after downgrade' where id = 'cc000000-0000-0000-0000-000000000011'$$,
  'downgrade keeps existing people editable'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'downgrade does not delete or demote existing editors automatically'
);
select lives_ok(
  $$insert into public.project_invitations (project_id, email, role, invited_by) values ('bb000000-0000-0000-0000-000000000003', 'downgraded-viewer@example.test', 'viewer', 'aa000000-0000-0000-0000-000000000002')$$,
  'unlimited viewers remain available in an existing project after downgrade'
);
select throws_ok(
  $$insert into public.project_invitations (project_id, email, role, invited_by) values ('bb000000-0000-0000-0000-000000000002', 'new-editor-after-downgrade@example.test', 'editor', 'aa000000-0000-0000-0000-000000000002')$$,
  'P0001',
  'PLAN_LIMIT_REACHED:editors_total',
  'downgrade blocks a new editor while preserving existing memberships'
);
select is(
  public.get_plan_usage('aa000000-0000-0000-0000-000000000002', 'editors_total', null),
  2,
  'viewer invitations never change editor usage'
);

select * from finish();
rollback;
