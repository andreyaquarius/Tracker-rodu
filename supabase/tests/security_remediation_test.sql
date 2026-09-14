-- Additional audit controls; synthetic records only; always rolled back.
begin;
set local statement_timeout = '30s';
set local lock_timeout = '5s';
set constraints all immediate;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- Runs with the caller's role. A successful unexpected write is also rolled back
-- by the subtransaction, so later cases cannot pass because of a duplicate key.
create function pg_temp.rejected(q text) returns boolean language plpgsql security invoker as $$
begin
  begin
    execute q;
    set constraints all immediate;
    raise sqlstate 'ZX001' using message='AUDIT_UNEXPECTED_SUCCESS';
  exception
    when sqlstate 'ZX001' then return false;
    when insufficient_privilege or foreign_key_violation or check_violation then return true;
  end;
end $$;

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',
  ('99991400-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'authenticated','authenticated','security-remediation-'||n||'@example.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from generate_series(1,4) n;
insert into projects(id,owner_id,name) values
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','Synthetic audit A'),
 ('99991400-0000-4000-8000-000000000102','99991400-0000-4000-8000-000000000002','Synthetic audit B');
insert into project_members(project_id,user_id,role,invited_by) values
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000003','editor','99991400-0000-4000-8000-000000000001'),
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000004','viewer','99991400-0000-4000-8000-000000000001');
insert into persons(id,project_id,created_by,full_name,is_living,privacy_status) values
 ('99991400-0000-4000-8000-000000000201','99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','Synthetic A',false,'project'),
 ('99991400-0000-4000-8000-000000000202','99991400-0000-4000-8000-000000000102','99991400-0000-4000-8000-000000000002','Synthetic B',false,'project'),
 ('99991400-0000-4000-8000-000000000203','99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','Приватна Синтетична Особа',true,'private');
insert into tasks(id,project_id,created_by,title) values
 ('99991400-0000-4000-8000-000000000231','99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','Task A'),
 ('99991400-0000-4000-8000-000000000232','99991400-0000-4000-8000-000000000102','99991400-0000-4000-8000-000000000002','Task B');
insert into hypotheses(id,project_id,created_by,title) values
 ('99991400-0000-4000-8000-000000000251','99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','Hypothesis A'),
 ('99991400-0000-4000-8000-000000000252','99991400-0000-4000-8000-000000000102','99991400-0000-4000-8000-000000000002','Hypothesis B');
insert into documents(id,project_id,created_by,title) values
 ('99991400-0000-4000-8000-000000000222','99991400-0000-4000-8000-000000000102','99991400-0000-4000-8000-000000000002','Document B');
insert into activity_log(project_id,actor_id,action,entity_type,entity_id,details) values
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','create','persons','99991400-0000-4000-8000-000000000203',
 '{"text":"Створено картку особи «Приватна Синтетична Особа»","module":"persons","relatedId":"99991400-0000-4000-8000-000000000203"}');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is((select count(*)::int from persons where id='99991400-0000-4000-8000-000000000203'),1,'owner can see private person - positive control');
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000004","role":"authenticated"}',true);
select is((select count(*)::int from persons where id='99991400-0000-4000-8000-000000000203'),0,'viewer cannot see private living person');
select is((select count(*)::int from persons where id='99991400-0000-4000-8000-000000000201'),1,'viewer can see permitted person - positive control');
select is((select count(*)::int from activity_log where entity_id='99991400-0000-4000-8000-000000000203' and details->>'text' like '%Приватна Синтетична Особа%'),0,'TR-SEC-01 viewer must not receive hidden private name from activity_log');
select ok(pg_temp.rejected($q$insert into task_persons(project_id,task_id,person_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000231','99991400-0000-4000-8000-000000000201')$q$),'viewer cannot write task links');

select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::int from persons where project_id='99991400-0000-4000-8000-000000000101'),0,'outsider B cannot read persons A');
select is((select count(*)::int from activity_log where project_id='99991400-0000-4000-8000-000000000101'),0,'outsider B cannot read activity A');
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is((select count(*)::int from persons where project_id='99991400-0000-4000-8000-000000000102'),0,'editor A cannot read persons B');
select ok(pg_temp.rejected($q$insert into task_persons(project_id,task_id,person_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000231','99991400-0000-4000-8000-000000000202')$q$),'TR-SEC-08 task A must reject person B');
select ok(pg_temp.rejected($q$insert into task_persons(project_id,task_id,person_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000232','99991400-0000-4000-8000-000000000201')$q$),'TR-SEC-08 project A must reject task B');
select ok(pg_temp.rejected($q$insert into hypothesis_links(project_id,hypothesis_id,target_type,target_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000251','person','99991400-0000-4000-8000-000000000202')$q$),'TR-SEC-08 hypothesis A must reject person B');
select ok(pg_temp.rejected($q$insert into hypothesis_links(project_id,hypothesis_id,target_type,target_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000252','person','99991400-0000-4000-8000-000000000201')$q$),'TR-SEC-08 project A must reject hypothesis B');
select ok(pg_temp.rejected($q$insert into hypothesis_links(project_id,hypothesis_id,target_type,target_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000251','document','99991400-0000-4000-8000-000000000222')$q$),'TR-SEC-08 hypothesis A must reject document B');
select ok(pg_temp.rejected($q$insert into person_relations(project_id,person_id,related_person_id,relation_type,created_by) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000201','99991400-0000-4000-8000-000000000202','brother','99991400-0000-4000-8000-000000000003')$q$),'ordinary person relation rejects foreign endpoint');
select lives_ok($q$insert into task_persons(project_id,task_id,person_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000231','99991400-0000-4000-8000-000000000201')$q$,'same-project task link works');
select lives_ok($q$insert into hypothesis_links(project_id,hypothesis_id,target_type,target_id) values('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000251','person','99991400-0000-4000-8000-000000000201')$q$,'same-project hypothesis link works');
select ok(pg_temp.rejected($q$update task_persons set person_id='99991400-0000-4000-8000-000000000202' where project_id='99991400-0000-4000-8000-000000000101'$q$),'TR-SEC-08 task link UPDATE must reject person B');
select ok(pg_temp.rejected($q$update hypothesis_links set target_id='99991400-0000-4000-8000-000000000202' where project_id='99991400-0000-4000-8000-000000000101'$q$),'TR-SEC-08 hypothesis link UPDATE must reject person B');
reset role;
delete from project_members where project_id='99991400-0000-4000-8000-000000000101' and user_id='99991400-0000-4000-8000-000000000004';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000004","role":"authenticated"}',true);
select is((select count(*)::int from persons where project_id='99991400-0000-4000-8000-000000000101'),0,'removed viewer cannot read using old claims');
select is((select count(*)::int from activity_log where project_id='99991400-0000-4000-8000-000000000101'),0,'removed viewer cannot read activity using old claims');
select ok(pg_temp.rejected($q$select public.get_dashboard_stats('99991400-0000-4000-8000-000000000101')$q$),'removed viewer cannot invoke project dashboard');
reset role;
-- Historical raw text stays owner/editor-only, including arbitrary titles.
insert into activity_log(project_id,actor_id,action,entity_type,details) values
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000001','record_updated','documents',
  '{"text":"Приватна Синтетична Особа","module":"documents"}');
insert into project_members(project_id,user_id,role,invited_by) values
 ('99991400-0000-4000-8000-000000000101','99991400-0000-4000-8000-000000000004','viewer','99991400-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000004","role":"authenticated"}',true);
select is((select count(*)::int from activity_log where project_id='99991400-0000-4000-8000-000000000101'),0,'viewer cannot bypass privacy via raw history');
select ok(not exists(select 1 from public.list_project_activity_v1('99991400-0000-4000-8000-000000000101') a where a.details::text like '%Приватна%'),'viewer RPC projects old private text out');
select ok(exists(select 1 from public.list_project_activity_v1('99991400-0000-4000-8000-000000000101')),'viewer still has safe activity history');
select ok(not exists(select 1 from public.project_change_events e where e.project_id='99991400-0000-4000-8000-000000000101' and to_jsonb(e)::text like '%Приватна%'),'Realtime rows contain no copied names');
select ok(exists(select 1 from public.project_change_events where project_id='99991400-0000-4000-8000-000000000101'),'viewer gets minimal invalidation');
select ok(pg_temp.rejected($q$select public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')$q$),'browser cannot claim delivery with forged actor');
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000001","role":"authenticated"}',true);
select ok(exists(select 1 from public.list_project_activity_v1('99991400-0000-4000-8000-000000000101') a where a.details::text like '%Приватна%'),'owner retains original history');
select set_config('request.jwt.claims','{"sub":"99991400-0000-4000-8000-000000000002","role":"authenticated"}',true);
select ok(pg_temp.rejected($q$select public.list_project_activity_v1('99991400-0000-4000-8000-000000000101')$q$),'outsider cannot invoke activity projection');
select is((select count(*)::int from public.project_change_events where project_id='99991400-0000-4000-8000-000000000101'),0,'outsider has no invalidation rows');
reset role;
select ok(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='activity_log'),'raw history is not replicated');
insert into project_invitations(id,project_id,email,role,invited_by) values
 ('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000101','security-invite@example.invalid','viewer','99991400-0000-4000-8000-000000000001');
set local role service_role;
select ok(pg_temp.rejected($q$select public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000002')$q$),'verified outsider cannot send another owner invitation');
select is(public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')->>'status','claimed','first delivery is atomically claimed');
select is(public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')->>'status','cooldown','second identical call cannot deliver');
reset role;
create temp table previous_claim as select id,lease_token,snapshot from security_private.invitation_email_deliveries where invitation_id='99991400-0000-4000-8000-000000000301';
update security_private.invitation_email_deliveries set last_attempt_at=now()-interval '3 minutes',lease_until=now()-interval '1 second' where invitation_id='99991400-0000-4000-8000-000000000301';
set local role service_role;
select is(public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')->>'status','claimed','ambiguous delivery can be retried after lease expiry');
reset role;
select is((select id from security_private.invitation_email_deliveries where invitation_id='99991400-0000-4000-8000-000000000301'),(select id from previous_claim),'retry keeps provider idempotency key');
select is((select snapshot from security_private.invitation_email_deliveries where invitation_id='99991400-0000-4000-8000-000000000301'),(select snapshot from previous_claim),'retry keeps frozen recipient and message');
select public.finish_invitation_email_v1(id,lease_token,true) from previous_claim;
select ok((select sent_at is null from security_private.invitation_email_deliveries where invitation_id='99991400-0000-4000-8000-000000000301'),'stale completion token cannot change newer lease');
select public.finish_invitation_email_v1(id,lease_token,true) from security_private.invitation_email_deliveries where invitation_id='99991400-0000-4000-8000-000000000301';
select is(public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')->>'status','cooldown','successful delivery has resend cooldown');
update project_invitations set status='revoked' where id='99991400-0000-4000-8000-000000000301';
select ok(pg_temp.rejected($q$select public.claim_invitation_email_v1('99991400-0000-4000-8000-000000000301','99991400-0000-4000-8000-000000000001')$q$),'revoked invitation cannot be resent');
select * from finish();
rollback;
