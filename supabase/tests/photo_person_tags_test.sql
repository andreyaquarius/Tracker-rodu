begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(28);

select has_table('public', 'photo_person_tags', 'tag table exists');
select ok((select relrowsecurity from pg_class where oid='public.photo_person_tags'::regclass), 'RLS is enabled');
select ok(not has_table_privilege('anon','public.photo_person_tags','SELECT'), 'anonymous cannot read tags');
select is((select count(*)::integer from pg_constraint where conrelid='public.photo_person_tags'::regclass and contype='f' and array_length(conkey,1)=2), 2, 'both source and person have project-scoped foreign keys');
select ok('photo_person_tags'=any(private.project_deletion_phase_names()), 'project deletion includes tags');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
select '00000000-0000-0000-0000-000000000000',
  ('0600aa00-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'authenticated','authenticated','photo-tag-'||n||'@example.test','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now(),now()
from generate_series(1,4) n;
insert into public.profiles(user_id,email,display_name)
select ('0600aa00-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
  'photo-tag-'||n||'@example.test','Synthetic photo user '||n
from generate_series(1,4) n on conflict(user_id) do nothing;
insert into public.projects(id,owner_id,name) values
  ('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000001','Photo tag test'),
  ('0600aa00-0000-4000-8000-000000000020','0600aa00-0000-4000-8000-000000000001','Other photo project');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000002','editor','0600aa00-0000-4000-8000-000000000001'),
  ('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000003','viewer','0600aa00-0000-4000-8000-000000000001');
insert into public.persons(id,project_id,full_name,is_living,privacy_status,created_by) values
  ('0600aa00-0000-4000-8000-000000000101','0600aa00-0000-4000-8000-000000000010','Synthetic Anna',false,'project','0600aa00-0000-4000-8000-000000000001'),
  ('0600aa00-0000-4000-8000-000000000102','0600aa00-0000-4000-8000-000000000010','Synthetic Bohdan',false,'project','0600aa00-0000-4000-8000-000000000001'),
  ('0600aa00-0000-4000-8000-000000000103','0600aa00-0000-4000-8000-000000000010','Synthetic Private',true,'private','0600aa00-0000-4000-8000-000000000001'),
  ('0600aa00-0000-4000-8000-000000000104','0600aa00-0000-4000-8000-000000000020','Synthetic Foreign',false,'project','0600aa00-0000-4000-8000-000000000001');
insert into public.documents(id,project_id,title,custom_fields,created_by) values
  ('0600aa00-0000-4000-8000-000000000201','0600aa00-0000-4000-8000-000000000010','Synthetic group photo',
   '{"__trackerRoduDocumentScans":[{"id":"0600aa00-0000-4000-8000-000000000301","storage":"google-drive","storagePath":"synthetic-drive-id","driveResourceKey":"synthetic-key"}]}',
   '0600aa00-0000-4000-8000-000000000001');
insert into public.attachments(id,project_id,owner_type,owner_id,field_key,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by) values
  ('0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000010','documents','0600aa00-0000-4000-8000-000000000201','scans','google-drive','synthetic-drive-id','Synthetic group.png','image/png',100,'0600aa00-0000-4000-8000-000000000001');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"0600aa00-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.photo_anna',public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000101',.1,.2,.3,.4)::text,true);
select set_config('test.photo_bohdan',public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000102',.5,.2,.3,.4)::text,true);
select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000103',.2,.2,.3,.4);
select is(jsonb_array_length(public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301')->'tags'),3,'three people on one photo');
select is(jsonb_array_length(public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010',null,'0600aa00-0000-4000-8000-000000000101')->'tags'),1,'person card contains tagged photo');
select is(public.photo_tag_source_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301')->>'storagePath','synthetic-drive-id','source is durable Drive identity');
select is((select x from photo_person_tags where id=current_setting('test.photo_anna')::uuid),.1::numeric,'normalized coordinates persist');
select throws_ok($q$select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000101',.1,.2,.3,.4)$q$,'23505',null,'duplicate person rejected');
select throws_ok($q$select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000104',.1,.2,.3,.4)$q$,'42501',null,'cross-project person rejected');
select throws_ok($q$select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000101',.9,.2,.3,.4,current_setting('test.photo_anna')::uuid,1)$q$,'23514',null,'out-of-image rectangle rejected');
select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000101',.2,.2,.3,.4,current_setting('test.photo_anna')::uuid,1);
select is((select version from photo_person_tags where id=current_setting('test.photo_anna')::uuid),2,'edit increments version');
select throws_ok($q$select public.delete_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010',current_setting('test.photo_anna')::uuid,1)$q$,'40001',null,'stale delete rejected');

select set_config('request.jwt.claims','{"sub":"0600aa00-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is(jsonb_array_length(public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301')->'tags'),2,'viewer sees only accessible people');
select is((select count(*)::integer from public.search_photo_tag_persons_v1('0600aa00-0000-4000-8000-000000000010','Synthetic')),2,'search hides private and foreign people');
select throws_ok($q$select public.save_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301','0600aa00-0000-4000-8000-000000000101',.1,.2,.3,.4)$q$,'42501',null,'viewer cannot insert');
select throws_ok($q$select public.delete_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010',current_setting('test.photo_anna')::uuid,2)$q$,'40001',null,'viewer cannot delete');
select throws_ok($q$select public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010',null,'0600aa00-0000-4000-8000-000000000103')$q$,'42501',null,'private person card denied');

select set_config('request.jwt.claims','{"sub":"0600aa00-0000-4000-8000-000000000004","role":"authenticated"}',true);
select is((select count(*)::integer from photo_person_tags where project_id='0600aa00-0000-4000-8000-000000000010'),0,'outsider cannot read table rows');
select is((select count(*)::integer from public.search_photo_tag_persons_v1('0600aa00-0000-4000-8000-000000000010','Synthetic')),0,'outsider search is empty');

select set_config('request.jwt.claims','{"sub":"0600aa00-0000-4000-8000-000000000002","role":"authenticated"}',true);
select lives_ok($q$select public.delete_photo_person_tag_v1('0600aa00-0000-4000-8000-000000000010',current_setting('test.photo_bohdan')::uuid,1)$q$,'editor may delete tag');
select is((select count(*)::integer from attachments where id='0600aa00-0000-4000-8000-000000000301'),1,'deleting tag preserves original attachment');
select is((select count(*)::integer from persons where id='0600aa00-0000-4000-8000-000000000102'),1,'deleting tag preserves person');
select is(jsonb_array_length(public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010',null,'0600aa00-0000-4000-8000-000000000102')->'tags'),0,'removed tag disappears from card');
update documents set custom_fields='{}' where id='0600aa00-0000-4000-8000-000000000201';
select is(jsonb_array_length(public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010',null,'0600aa00-0000-4000-8000-000000000101')->'tags'),0,'removed source reference hides photo in card');
reset role;
update attachments set storage_path='replacement-file' where id='0600aa00-0000-4000-8000-000000000301';
select is((select count(*)::integer from photo_person_tags where project_id='0600aa00-0000-4000-8000-000000000010'),0,'source replacement deletes obsolete rectangles');
set local role anon;
select throws_ok($q$select public.list_photo_person_tags_v1('0600aa00-0000-4000-8000-000000000010','0600aa00-0000-4000-8000-000000000301')$q$,'42501',null,'anonymous RPC access denied');
reset role;
select * from finish();
rollback;
