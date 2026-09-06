-- Local Docker only. Synthetic records; do not apply to a hosted project.
begin;
do $seed$
declare owner_user uuid; image_scan jsonb;
begin
  select id into owner_user from auth.users where email='photo-tags-local@example.test';
  if owner_user is null then raise exception 'Create the local test user first'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',owner_user,'role','authenticated')::text,true);
  insert into public.projects(id,owner_id,name,slug,description)
    values('0600bb00-0000-4000-8000-000000000010',owner_user,'Локальний тест — люди на фото','photo-tags-local',
      'Синтетичний проєкт для перевірки позначок. Дані зберігаються лише в локальному Docker Supabase.')
    on conflict(id) do nothing;
  insert into public.persons(id,project_id,full_name,surname,given_name,birth_date,is_living,privacy_status,notes,created_by) values
    ('0600bb00-0000-4000-8000-000000000101','0600bb00-0000-4000-8000-000000000010','Анна Тестова','Тестова','Анна','1900',false,'project','Синтетична особа для тестування позначок на фото.',owner_user),
    ('0600bb00-0000-4000-8000-000000000102','0600bb00-0000-4000-8000-000000000010','Богдан Тестовий','Тестовий','Богдан','1898',false,'project','Синтетична особа для тестування позначок на фото.',owner_user)
    on conflict(id) do nothing;
  image_scan := jsonb_build_object('id','0600bb00-0000-4000-8000-000000000301','name','Групове фото — локальний тест.svg',
    'mimeType','image/svg+xml','size',800,'createdAt','2026-09-06T00:00:00Z','storage','google-drive',
    'storagePath','synthetic-photo-tags-group-v1','deleteOnRemove',false);
  insert into public.documents(id,project_id,title,description,custom_fields,created_by) values(
    '0600bb00-0000-4000-8000-000000000201','0600bb00-0000-4000-8000-000000000010','Групове фото — тест позначок',
    'Синтетичне зображення. Його локальна копія підготовлена в кеші браузера; Google Drive не використовується.',
    jsonb_build_object('__trackerRoduDocumentScans',jsonb_build_array(image_scan)),owner_user)
    on conflict(id) do nothing;
  insert into public.attachments(id,project_id,owner_type,owner_id,field_key,storage_bucket,storage_path,file_name,mime_type,size_bytes,uploaded_by,created_at)
    values('0600bb00-0000-4000-8000-000000000301','0600bb00-0000-4000-8000-000000000010','documents',
      '0600bb00-0000-4000-8000-000000000201','scans','google-drive','synthetic-photo-tags-group-v1',
      'Групове фото — локальний тест.svg','image/svg+xml',800,owner_user,'2026-09-06T00:00:00Z')
    on conflict(id) do nothing;
  insert into public.photo_person_tags(project_id,attachment_id,person_id,x,y,width,height) values
    ('0600bb00-0000-4000-8000-000000000010','0600bb00-0000-4000-8000-000000000301','0600bb00-0000-4000-8000-000000000101',.13,.17,.3,.65),
    ('0600bb00-0000-4000-8000-000000000010','0600bb00-0000-4000-8000-000000000301','0600bb00-0000-4000-8000-000000000102',.57,.17,.28,.65)
    on conflict(attachment_id,person_id) do nothing;
end;
$seed$;
commit;
