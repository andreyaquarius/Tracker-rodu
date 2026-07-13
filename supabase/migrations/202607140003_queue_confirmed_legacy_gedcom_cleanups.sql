begin;

-- One-time, explicitly approved cleanup targets.  The migration only queues a
-- resumable job; all deletion remains bounded in the scheduled worker.  It is
-- replay-safe on clean/staging databases and fails closed on any partial or
-- unexpected production state.
do $$
declare
  target_count integer;
  preserved_source_count integer;
  owner_id uuid;
  queued_job_id uuid;
begin
  if exists (
    select 1 from public.projects
    where id = '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid
  ) then
    select project.owner_id into owner_id
    from public.projects project
    where project.id = '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid;

    select count(*)::integer into target_count
    from public.persons person
    where person.project_id = '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid
      and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
      and person.custom_fields ->> '__gedcomImportSourceKey' =
          'gedcom-content:b160258f4be37cfbc05b7cf536a2d780';

    if target_count = 17556 then
      select count(*)::integer into preserved_source_count
      from public.persons person
      where person.project_id = '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid
        and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
        and person.custom_fields ->> '__gedcomImportSourceKey' =
            'myheritage-project:a7fxu888-9f56-75ze-8ar2-8ar25f9e16aj';
      if preserved_source_count <> 2480 then
        raise exception
          'YURII_PRESERVED_SOURCE_COUNT_MISMATCH:expected=2480,actual=%',
          preserved_source_count using errcode = '22023';
      end if;

      queued_job_id := private.create_legacy_gedcom_cleanup_job(
        '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid,
        'gedcom-content:b160258f4be37cfbc05b7cf536a2d780',
        17556,
        owner_id
      );

      -- create_legacy_gedcom_cleanup_job now holds SHARE locks on persons until
      -- this migration transaction commits.  Re-check the preserved source
      -- under those locks so the preflight value cannot race the snapshot.
      select count(*)::integer into preserved_source_count
      from public.persons person
      where person.project_id = '9ec3889d-3532-48e4-870b-c6d61caec47d'::uuid
        and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
        and person.custom_fields ->> '__gedcomImportSourceKey' =
            'myheritage-project:a7fxu888-9f56-75ze-8ar2-8ar25f9e16aj';
      if preserved_source_count <> 2480 then
        raise exception
          'YURII_PRESERVED_SOURCE_COUNT_CHANGED_AFTER_LOCK:expected=2480,actual=%',
          preserved_source_count using errcode = '22023';
      end if;
      raise notice 'Queued confirmed legacy GEDCOM cleanup job %', queued_job_id;
    elsif target_count = 0 then
      raise notice 'Confirmed Yurii legacy GEDCOM source is already clean';
    else
      raise exception
        'YURII_TARGET_SOURCE_COUNT_MISMATCH:expected=17556_or_0,actual=%',
        target_count using errcode = '22023';
    end if;
  else
    raise notice 'Yurii production project is absent; skipping confirmed cleanup target';
  end if;

  if exists (
    select 1 from public.projects
    where id = '29547cd4-4d68-4328-b0c2-0a42abab1c75'::uuid
  ) then
    select project.owner_id into owner_id
    from public.projects project
    where project.id = '29547cd4-4d68-4328-b0c2-0a42abab1c75'::uuid;

    select count(*)::integer into target_count
    from public.persons person
    where person.project_id = '29547cd4-4d68-4328-b0c2-0a42abab1c75'::uuid
      and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
      and person.custom_fields ->> '__gedcomImportSourceKey' =
          'gedcom-content:1fd05b33e6e557e32c1502947d78c1dd';

    if target_count = 2760 then
      queued_job_id := private.create_legacy_gedcom_cleanup_job(
        '29547cd4-4d68-4328-b0c2-0a42abab1c75'::uuid,
        'gedcom-content:1fd05b33e6e557e32c1502947d78c1dd',
        2760,
        owner_id
      );
      raise notice 'Queued confirmed legacy GEDCOM cleanup job %', queued_job_id;
    elsif target_count = 0 then
      raise notice 'Confirmed Alexandr legacy GEDCOM source is already clean';
    else
      raise exception
        'ALEXANDR_TARGET_SOURCE_COUNT_MISMATCH:expected=2760_or_0,actual=%',
        target_count using errcode = '22023';
    end if;
  else
    raise notice 'Alexandr production project is absent; skipping confirmed cleanup target';
  end if;
end;
$$;

commit;
