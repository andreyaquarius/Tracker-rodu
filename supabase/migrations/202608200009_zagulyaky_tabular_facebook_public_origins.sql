begin;

-- Keep the server-side acceptance rule aligned with the browser's defensive
-- renderer.  A malformed or non-Facebook value can remain in the private
-- workbook ledger, but it is never copied into the publishable-origin map.
create or replace function security_private.zagulyaky_is_facebook_post_url_v1(
  p_url text
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select coalesce(p_url, '') ~* '^https?://([a-z0-9-]+[.])*(facebook[.]com|fb[.]com|fb[.]me)([:/?#]|$)'
$function$;

-- A tabular workbook's Facebook post URL is private provenance by default.
-- Keep a one-row-per-record map for the imported initial base instead of
-- copying Facebook data into catalogue sources during materialisation.  A
-- moderator must make the later, reversible public-link decision explicitly.
create table if not exists public.zagulyaky_tabular_import_record_origins (
  record_id uuid primary key references public.zagulyaky_records(id) on delete cascade,
  card_id uuid not null unique references public.zagulyaky_tabular_import_cards(id) on delete cascade,
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  source_post_id uuid not null references public.zagulyaky_tabular_import_source_posts(id) on delete cascade,
  facebook_post_url_private text not null
    check (
      char_length(facebook_post_url_private) between 1 and 4000
      and facebook_post_url_private ~* '^https?://'
      and security_private.zagulyaky_is_facebook_post_url_v1(facebook_post_url_private)
    ),
  public_link_status text not null default 'private'
    check (public_link_status in ('private', 'approved', 'revoked')),
  source_id uuid unique references public.zagulyaky_sources(id) on delete set null,
  reviewed_by uuid references public.profiles(user_id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists zagulyaky_tabular_import_record_origins_status_idx
  on public.zagulyaky_tabular_import_record_origins(public_link_status, reviewed_at desc);
create index if not exists zagulyaky_tabular_import_record_origins_batch_idx
  on public.zagulyaky_tabular_import_record_origins(batch_id, record_id);

alter table public.zagulyaky_tabular_import_record_origins enable row level security;
revoke all on table public.zagulyaky_tabular_import_record_origins from public, anon, authenticated;
grant all on table public.zagulyaky_tabular_import_record_origins to service_role;

-- Backfill the already-created initial-base drafts.  This does not create a
-- public source row and does not change the record's workflow or privacy
-- state; the link remains private until an explicit moderation action.
insert into public.zagulyaky_tabular_import_record_origins (
  record_id,
  card_id,
  batch_id,
  source_post_id,
  facebook_post_url_private
)
select
  record_map.record_id,
  card_row.id,
  card_row.batch_id,
  post_row.id,
  post_row.facebook_post_url_private
from public.zagulyaky_tabular_import_card_records record_map
join public.zagulyaky_tabular_import_cards card_row
  on card_row.id = record_map.card_id
  and card_row.batch_id = record_map.batch_id
join public.zagulyaky_tabular_import_source_posts post_row
  on post_row.batch_id = card_row.batch_id
  and post_row.post_key = card_row.post_key
where nullif(btrim(post_row.facebook_post_url_private), '') is not null
  and security_private.zagulyaky_is_facebook_post_url_v1(post_row.facebook_post_url_private)
on conflict (record_id) do nothing;

-- Keep the protected mapping available for subsequent tabular imports as
-- well.  The trigger still only captures private provenance; it never creates
-- a catalogue source or changes a record's public visibility.
create or replace function security_private.capture_zagulyaky_tabular_record_origin_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  insert into public.zagulyaky_tabular_import_record_origins (
    record_id,
    card_id,
    batch_id,
    source_post_id,
    facebook_post_url_private
  )
  select
    new.record_id,
    card_row.id,
    card_row.batch_id,
    post_row.id,
    post_row.facebook_post_url_private
  from public.zagulyaky_tabular_import_cards card_row
  join public.zagulyaky_tabular_import_source_posts post_row
    on post_row.batch_id = card_row.batch_id
    and post_row.post_key = card_row.post_key
  where card_row.id = new.card_id
    and card_row.batch_id = new.batch_id
    and nullif(btrim(post_row.facebook_post_url_private), '') is not null
    and security_private.zagulyaky_is_facebook_post_url_v1(post_row.facebook_post_url_private)
  on conflict (record_id) do nothing;

  return new;
end;
$function$;

drop trigger if exists zagulyaky_tabular_import_card_record_origin_capture
  on public.zagulyaky_tabular_import_card_records;
create trigger zagulyaky_tabular_import_card_record_origin_capture
after insert on public.zagulyaky_tabular_import_card_records
for each row execute function security_private.capture_zagulyaky_tabular_record_origin_v1();

-- This helper is intentionally non-public.  The public detail facade below
-- calls it only after the existing published/cleared/living-person gates have
-- passed.  It does not inspect workbook text, author labels, collection URLs,
-- event notes, or any other private provenance.
create or replace function security_private.zagulyaky_public_facebook_origin_v1(
  p_record_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object('originalPostUrl', origin_row.facebook_post_url_private)
  from public.zagulyaky_tabular_import_record_origins origin_row
  join public.zagulyaky_records record_row
    on record_row.id = origin_row.record_id
  join public.zagulyaky_sources source_row
    on source_row.id = origin_row.source_id
  join public.zagulyaky_record_sources record_source
    on record_source.record_id = record_row.id
    and record_source.source_id = source_row.id
  where origin_row.record_id = p_record_id
    and origin_row.public_link_status = 'approved'
    and record_row.status = 'published'
    and record_row.privacy_status = 'cleared'
    and source_row.source_type = 'social_post'
    and lower(coalesce(source_row.source_platform, '')) = 'facebook'
    and source_row.source_url = origin_row.facebook_post_url_private
    and security_private.zagulyaky_is_facebook_post_url_v1(origin_row.facebook_post_url_private)
    and source_row.permission_status in ('link_only', 'permission_granted', 'public_domain')
  limit 1
$function$;

-- The bulk moderation UI can call this in bounded, resumable chunks.  The
-- return value contains counts only: never an imported URL or source text.
-- Enabling the link creates the smallest possible public source projection
-- (platform, generic title, and URL); disabling it removes the record link
-- immediately and records a reversible audit trail.
create or replace function security_private.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
  p_record_ids uuid[],
  p_public_visible boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  requested_record_ids uuid[];
  requested_count integer := 0;
  mapped_count integer := 0;
  approved_count integer := 0;
  revoked_count integer := 0;
  unchanged_count integer := 0;
  non_facebook_origin_count integer := 0;
  source_id_to_use uuid;
  origin_row public.zagulyaky_tabular_import_record_origins%rowtype;
begin
  if current_user_id is null
    or not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_public_visible is null then
    raise exception 'PUBLIC_ORIGIN_VISIBILITY_REQUIRED' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct requested.record_id order by requested.record_id), '{}'::uuid[])
    into requested_record_ids
  from unnest(coalesce(p_record_ids, '{}'::uuid[])) as requested(record_id)
  where requested.record_id is not null;

  requested_count := cardinality(requested_record_ids);
  if requested_count not between 1 and 250 then
    raise exception 'INVALID_PUBLIC_ORIGIN_BATCH_SIZE' using errcode = '22023';
  end if;

  -- All bulk workflow callers lock catalogue records first and then their
  -- origin maps.  Preserve that order here too: the source-link insert takes
  -- a foreign-key lock on the record, so taking it explicitly before the
  -- origin rows prevents a record/origin lock inversion with publication.
  perform record_row.id
  from public.zagulyaky_records record_row
  where record_row.id = any(requested_record_ids)
  order by record_row.id
  for update;

  for origin_row in
    select origin.*
    from public.zagulyaky_tabular_import_record_origins origin
    where origin.record_id = any(requested_record_ids)
    order by origin.record_id
    for update
  loop
    mapped_count := mapped_count + 1;

    if p_public_visible then
      -- The table constraint already enforces this for new rows, but retain a
      -- runtime guard for a legacy/manual service-row repair.  Such a row is
      -- deliberately left private rather than being recast as a Facebook
      -- source merely because it was stored in a similarly named field.
      if not security_private.zagulyaky_is_facebook_post_url_v1(origin_row.facebook_post_url_private) then
        non_facebook_origin_count := non_facebook_origin_count + 1;
        continue;
      end if;

      source_id_to_use := origin_row.source_id;

      if source_id_to_use is null or not exists (
        select 1
        from public.zagulyaky_sources source_row
        where source_row.id = source_id_to_use
          and source_row.source_type = 'social_post'
          and lower(coalesce(source_row.source_platform, '')) = 'facebook'
          and source_row.source_url = origin_row.facebook_post_url_private
          and source_row.permission_status in ('link_only', 'permission_granted', 'public_domain')
      ) then
        if origin_row.source_id is not null then
          delete from public.zagulyaky_record_sources record_source
          where record_source.record_id = origin_row.record_id
            and record_source.source_id = origin_row.source_id;

          delete from public.zagulyaky_sources source_row
          where source_row.id = origin_row.source_id
            and not exists (
              select 1
              from public.zagulyaky_record_sources remaining_link
              where remaining_link.source_id = source_row.id
            );
        end if;

        insert into public.zagulyaky_sources (
          source_type,
          title,
          citation,
          source_url,
          source_platform,
          permission_status,
          metadata,
          created_by
        ) values (
          'social_post',
          'Оригінальний допис у Facebook',
          '',
          origin_row.facebook_post_url_private,
          'facebook',
          'link_only',
          jsonb_build_object('originKind', 'facebook_post', 'tabularImport', true),
          current_user_id
        )
        returning id into source_id_to_use;
      end if;

      insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
      values (origin_row.record_id, source_id_to_use, false)
      on conflict (record_id, source_id) do nothing;

      if origin_row.public_link_status = 'approved'
        and origin_row.source_id = source_id_to_use then
        unchanged_count := unchanged_count + 1;
      else
        approved_count := approved_count + 1;
      end if;

      update public.zagulyaky_tabular_import_record_origins
      set public_link_status = 'approved',
          source_id = source_id_to_use,
          reviewed_by = current_user_id,
          reviewed_at = now(),
          updated_at = now()
      where record_id = origin_row.record_id;
    else
      if origin_row.public_link_status = 'private'
        and origin_row.source_id is null then
        unchanged_count := unchanged_count + 1;
      else
        if origin_row.source_id is not null then
          delete from public.zagulyaky_record_sources record_source
          where record_source.record_id = origin_row.record_id
            and record_source.source_id = origin_row.source_id;

          delete from public.zagulyaky_sources source_row
          where source_row.id = origin_row.source_id
            and not exists (
              select 1
              from public.zagulyaky_record_sources remaining_link
              where remaining_link.source_id = source_row.id
            );
        end if;

        update public.zagulyaky_tabular_import_record_origins
        set public_link_status = 'revoked',
            source_id = null,
            reviewed_by = current_user_id,
            reviewed_at = now(),
            updated_at = now()
        where record_id = origin_row.record_id;
        revoked_count := revoked_count + 1;
      end if;
    end if;
  end loop;

  insert into public.admin_audit_log(
    admin_actor_id,
    action_code,
    target_type,
    target_id,
    outcome,
    sanitized_diff
  ) values (
    current_user_id,
    case when p_public_visible
      then 'zagulyaky.tabular_facebook_origin.approve'
      else 'zagulyaky.tabular_facebook_origin.revoke'
    end,
    'zagulyaky_tabular_facebook_origins',
    'batch:' || requested_count::text,
    'success',
    jsonb_build_object(
      'requestedCount', requested_count,
      'mappedCount', mapped_count,
      'approvedCount', approved_count,
      'revokedCount', revoked_count,
      'unchangedCount', unchanged_count,
      'nonFacebookOriginCount', non_facebook_origin_count,
      'missingOriginCount', requested_count - mapped_count
    )
  );

  return jsonb_build_object(
    'requestedCount', requested_count,
    'mappedCount', mapped_count,
    'approvedCount', approved_count,
    'revokedCount', revoked_count,
    'unchangedCount', unchanged_count,
    'nonFacebookOriginCount', non_facebook_origin_count,
    'missingOriginCount', requested_count - mapped_count
  );
end;
$function$;

create or replace function public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
  p_record_ids uuid[],
  p_public_visible boolean
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1($1, $2)
$function$;

-- Keep the existing public detail projection intact and append the link only
-- after all of its current visibility gates have passed.  Search RPCs are
-- deliberately untouched: neither the URL nor its private mapping is a
-- search field or a public browse result.
create or replace function public.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as (
    select security_private.get_public_zagulyaka_v1($1) as payload
  )
  select case
    when source.payload is null then null
    when exists (
      select 1
      from public.zagulyaky_records record_row
      where record_row.id::text = (source.payload ->> 'id')
        and record_row.possible_living_person
        and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
    ) then null
    else jsonb_set(
      source.payload,
      '{publicAttachments}',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', attachment.value -> 'id',
          'fileName', attachment.value -> 'fileName',
          'mimeType', attachment.value -> 'mimeType',
          'byteSize', attachment.value -> 'byteSize'
        ) order by attachment.ordinality)
        from jsonb_array_elements(coalesce(source.payload -> 'publicAttachments', '[]'::jsonb))
          with ordinality as attachment(value, ordinality)
      ), '[]'::jsonb),
      true
    ) || coalesce(
      security_private.zagulyaky_public_facebook_origin_v1((source.payload ->> 'id')::uuid),
      '{}'::jsonb
    )
  end
  from source
$function$;

revoke all on function security_private.capture_zagulyaky_tabular_record_origin_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_is_facebook_post_url_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_public_facebook_origin_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)
  to authenticated, service_role;

revoke all on function public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(uuid[],boolean)
  to authenticated, service_role;
revoke all on function public.get_public_zagulyaka_v1(text)
  from public;
grant execute on function public.get_public_zagulyaka_v1(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
