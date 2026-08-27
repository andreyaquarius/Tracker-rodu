begin;

-- Do not wait indefinitely behind a busy production writer. The migration is
-- deliberately atomic so an interrupted backfill cannot leave a mixed schema,
-- but lock acquisition must fail fast and be retried during a quiet window.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- Historical names extend the existing canonical projection instead of
-- replacing `persons`.  Legacy columns remain the compatibility source for
-- old clients; this migration never rewrites a value stored in `persons`.
create extension if not exists pg_trgm with schema extensions;
create schema if not exists security_private;

-- Exact backup restore needs to bypass only the enrichment trigger, never the
-- ownership or source checks around the public RPC.  A private transaction
-- marker cannot be forged by an API role and avoids disabling a table trigger
-- globally while another project is being read.
create table if not exists security_private.person_name_restore_context (
  transaction_id bigint not null,
  backend_pid integer not null,
  project_id uuid not null,
  created_at timestamptz not null default pg_catalog.now(),
  primary key (transaction_id, backend_pid, project_id)
);

revoke all on security_private.person_name_restore_context
  from public, anon, authenticated, service_role;

-- The schema/backfill below enriches existing rows but is not a user edit.
-- Temporarily suspend the generic timestamp trigger so historical updated_at
-- values keep their original meaning. The surrounding transaction restores
-- the trigger atomically on success and restores the old state on rollback.
drop trigger if exists person_names_set_updated_at on public.person_names;

alter table public.person_names
  drop constraint if exists person_names_name_type_check;

alter table public.person_names
  add column if not exists maiden_surname text not null default '',
  add column if not exists prefix text not null default '',
  add column if not exists suffix text not null default '',
  add column if not exists nickname text not null default '',
  add column if not exists full_normalized text not null default '',
  add column if not exists orthography text not null default '',
  add column if not exists valid_from text,
  add column if not exists valid_to text,
  add column if not exists date_precision text not null default 'unknown',
  add column if not exists is_searchable boolean not null default true,
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_id uuid,
  add column if not exists citation_id uuid,
  add column if not exists document_fragment_id uuid,
  add column if not exists original_tokens text[] not null default '{}'::text[],
  add column if not exists normalized_tokens text[] not null default '{}'::text[],
  add column if not exists transliteration_tokens text[] not null default '{}'::text[],
  add column if not exists simplified_tokens text[] not null default '{}'::text[],
  add column if not exists phonetic_key text not null default '',
  add column if not exists search_text text not null default '',
  add column if not exists created_by uuid references public.profiles(user_id) on delete set null,
  add column if not exists lock_version integer not null default 1;

alter table public.person_names
  drop constraint if exists person_names_name_type_format_check;
alter table public.person_names
  add constraint person_names_name_type_format_check
  check (
    name_type = btrim(name_type)
    and char_length(name_type) between 1 and 64
    and name_type ~ '^[a-z0-9][a-z0-9_-]*$'
  );

alter table public.person_names
  drop constraint if exists person_names_date_precision_format_check;
alter table public.person_names
  add constraint person_names_date_precision_format_check
  check (
    date_precision = any (array[
      'exact', 'day', 'month', 'year', 'range', 'circa',
      'before', 'after', 'between', 'unknown'
    ]::text[])
  );

alter table public.person_names
  drop constraint if exists person_names_lock_version_check;
alter table public.person_names
  add constraint person_names_lock_version_check check (lock_version > 0);

comment on column public.person_names.original_text is
  'Exact source spelling. Never normalized or overwritten by historical-name helpers.';
comment on column public.person_names.full_name is
  'Legacy compatible display value retained for existing clients.';
comment on column public.person_names.full_normalized is
  'User-confirmed normalized form; separate from the exact original_text.';
comment on column public.person_names.valid_from is
  'Human-entered historical date or year. It is intentionally text so circa and partial dates remain lossless.';
comment on column public.person_names.valid_to is
  'Human-entered historical date or year. Ordering is not inferred from arbitrary text.';
comment on column public.person_names.citation_id is
  'Optional forward-compatible citation identifier; no foreign key until the canonical citation entity exists.';
comment on column public.person_names.document_fragment_id is
  'Optional forward-compatible document-fragment identifier; source_finding_id remains the current canonical fragment link.';
comment on column public.person_names.phonetic_key is
  'Reserved derived field. It remains empty until a versioned phonetic algorithm is introduced; exact source data never depends on it.';

create or replace function public.person_name_search_normalize_v1(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select btrim(
    pg_catalog.regexp_replace(
      pg_catalog.translate(
        pg_catalog.translate(
          pg_catalog.lower(coalesce(p_value, '')),
          'ёѣѳѵыэ',
          'еефіие'
        ),
        'ąćęłńóśźżáčďéěíňřšťúůýž',
        'acelnoszzacdeeinrstuuyz'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  );
$function$;

-- Deterministic search-only transliteration.  It never writes into any
-- original or normalized name field.
create or replace function public.person_name_search_transliterate_v1(p_value text)
returns text
language plpgsql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
declare
  result text := pg_catalog.lower(coalesce(p_value, ''));
  source_chars constant text[] := array[
    'щ','ш','ч','ц','ю','я','є','ї','ж','х','ґ','г','й','і','и','ы','э','ё','ѣ','ѳ','ѵ',
    'а','б','в','д','е','з','к','л','м','н','о','п','р','с','т','у','ф','ъ','ь'
  ];
  target_chars constant text[] := array[
    'shch','sh','ch','ts','yu','ya','ye','yi','zh','kh','g','h','i','i','y','y','e','yo','ie','f','i',
    'a','b','v','d','e','z','k','l','m','n','o','p','r','s','t','u','f','',''
  ];
  item_index integer;
begin
  for item_index in 1..pg_catalog.array_length(source_chars, 1) loop
    result := pg_catalog.replace(result, source_chars[item_index], target_chars[item_index]);
  end loop;
  return public.person_name_search_normalize_v1(result);
end;
$function$;

create or replace function public.person_name_search_tokens_v1(p_value text)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $function$
  select coalesce(pg_catalog.array_agg(token order by token), '{}'::text[])
  from (
    select distinct token
    from pg_catalog.regexp_split_to_table(
      public.person_name_search_normalize_v1(p_value),
      '[[:space:]]+'
    ) token
    where token <> ''
  ) tokens;
$function$;

revoke all on function public.person_name_search_normalize_v1(text) from public, anon;
revoke all on function public.person_name_search_transliterate_v1(text) from public, anon;
revoke all on function public.person_name_search_tokens_v1(text) from public, anon;
grant execute on function public.person_name_search_normalize_v1(text) to authenticated, service_role;
grant execute on function public.person_name_search_transliterate_v1(text) to authenticated, service_role;
grant execute on function public.person_name_search_tokens_v1(text) to authenticated, service_role;

-- Backfill only the newly added columns.  In particular, original_text and
-- every column on persons are intentionally absent from this UPDATE.
update public.person_names name
set
  name_type = case
    when name.metadata #>> '{tracker_person_name_v2,nameType}' ~
      '^[a-z0-9][a-z0-9_-]{0,63}$'
      then name.metadata #>> '{tracker_person_name_v2,nameType}'
    else name.name_type
  end,
  maiden_surname = coalesce(
    nullif(name.maiden_surname, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,maidenSurname}', ''),
    ''
  ),
  prefix = coalesce(
    nullif(name.prefix, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,prefix}', ''),
    ''
  ),
  suffix = coalesce(
    nullif(name.suffix, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,suffix}', ''),
    ''
  ),
  nickname = coalesce(
    nullif(name.nickname, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,nickname}', ''),
    ''
  ),
  full_normalized = coalesce(
    nullif(name.full_normalized, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,fullNormalized}', ''),
    nullif(name.full_name, ''),
    nullif(btrim(name.surname || ' ' || name.given_name || ' ' || name.patronymic), ''),
    ''
  ),
  orthography = coalesce(
    nullif(name.orthography, ''),
    nullif(name.metadata #>> '{tracker_person_name_v2,orthography}', ''),
    ''
  ),
  valid_from = coalesce(
    name.valid_from,
    nullif(name.metadata #>> '{tracker_person_name_v2,validFrom}', '')
  ),
  valid_to = coalesce(
    name.valid_to,
    nullif(name.metadata #>> '{tracker_person_name_v2,validTo}', '')
  ),
  date_precision = case
    when name.date_precision = 'unknown'
      and name.metadata #>> '{tracker_person_name_v2,datePrecision}' = any (array[
        'exact', 'day', 'month', 'year', 'range', 'circa',
        'before', 'after', 'between', 'unknown'
      ]::text[])
      then name.metadata #>> '{tracker_person_name_v2,datePrecision}'
    else name.date_precision
  end,
  is_searchable = case
    when jsonb_typeof(name.metadata #> '{tracker_person_name_v2,isSearchable}') = 'boolean'
      then (name.metadata #>> '{tracker_person_name_v2,isSearchable}')::boolean
    else name.is_searchable
  end,
  source_type = case
    when name.source_finding_id is not null then 'finding'
    when name.source_document_id is not null then 'document'
    when name.metadata ->> 'source' like 'gedcom%' then 'gedcom'
    when name.metadata ->> 'source' = 'persons_projection' then 'legacy_person'
    else coalesce(
      nullif(name.source_type, 'manual'),
      nullif(name.metadata #>> '{tracker_person_name_v2,sourceType}', ''),
      nullif(name.source_type, ''),
      'manual'
    )
  end,
  source_id = case
    when name.source_finding_id is not null then name.source_finding_id
    when name.source_document_id is not null then name.source_document_id
    when name.source_id is not null then name.source_id
    when name.metadata #>> '{tracker_person_name_v2,sourceId}' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (name.metadata #>> '{tracker_person_name_v2,sourceId}')::uuid
    else null
  end,
  citation_id = case
    when name.citation_id is not null then name.citation_id
    when name.metadata #>> '{tracker_person_name_v2,citationId}' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (name.metadata #>> '{tracker_person_name_v2,citationId}')::uuid
    else null
  end,
  document_fragment_id = case
    when name.document_fragment_id is not null then name.document_fragment_id
    when name.metadata #>> '{tracker_person_name_v2,documentFragmentId}' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (name.metadata #>> '{tracker_person_name_v2,documentFragmentId}')::uuid
    else null
  end,
  created_by = coalesce(name.created_by, person.created_by)
from public.persons person
where person.id = name.person_id
  and person.project_id = name.project_id;

-- Refuse an unsafe upgrade instead of preserving a source UUID that points to
-- another project.  The migration is transactional, so this check fails with
-- the pre-migration data still intact and can be investigated before retrying.
do $source_validation$
begin
  if exists (
    select 1
    from public.person_names name
    left join public.documents document
      on document.id = name.source_document_id
      and document.project_id = name.project_id
    where name.source_document_id is not null and document.id is null
  ) or exists (
    select 1
    from public.person_names name
    left join public.documents document
      on document.id = name.source_id
      and document.project_id = name.project_id
    where name.source_type = 'document'
      and name.source_id is not null
      and document.id is null
  ) then
    raise exception 'PERSON_NAME_SOURCE_DOCUMENT_PROJECT_MISMATCH'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.person_names name
    left join public.findings finding
      on finding.id = name.source_finding_id
      and finding.project_id = name.project_id
    where name.source_finding_id is not null and finding.id is null
  ) or exists (
    select 1
    from public.person_names name
    left join public.findings finding
      on finding.id = name.source_id
      and finding.project_id = name.project_id
    where name.source_type = 'finding'
      and name.source_id is not null
      and finding.id is null
  ) then
    raise exception 'PERSON_NAME_SOURCE_FINDING_PROJECT_MISMATCH'
      using errcode = '23503';
  end if;
end;
$source_validation$;

-- Every legacy person keeps a dedicated compatibility projection. If a manual
-- historical name is already primary, the projection is inserted as a
-- non-primary searchable variant and does not displace the user's choice.
insert into public.person_names (
  project_id, person_id, name_type, language_code, script_code,
  surname, given_name, patronymic, full_name, original_text,
  full_normalized, is_primary, is_preferred, is_searchable,
  evidence_status, confidence, source_type, created_by, metadata
)
select
  person.project_id,
  person.id,
  'primary',
  'uk',
  'Cyrl',
  person.surname,
  person.given_name,
  person.patronymic,
  coalesce(nullif(person.full_name, ''), btrim(person.surname || ' ' || person.given_name || ' ' || person.patronymic)),
  coalesce(nullif(person.full_name, ''), btrim(person.surname || ' ' || person.given_name || ' ' || person.patronymic)),
  coalesce(nullif(person.full_name, ''), btrim(person.surname || ' ' || person.given_name || ' ' || person.patronymic)),
  not exists (
    select 1 from public.person_names primary_name
    where primary_name.person_id = person.id and primary_name.is_primary
  ),
  not exists (
    select 1 from public.person_names primary_name
    where primary_name.person_id = person.id and primary_name.is_primary
  ),
  true,
  case person.status
    when 'доведена' then 'proven'
    when 'відома особисто' then 'proven'
    when 'відома документально' then 'proven'
    when 'частково доведена' then 'likely'
    when 'відома з переказів' then 'likely'
    when 'сумнівна' then 'disputed'
    when 'спростована' then 'disproven'
    else 'unknown'
  end,
  case person.status
    when 'доведена' then 100
    when 'відома особисто' then 100
    when 'відома документально' then 100
    when 'частково доведена' then 70
    when 'відома з переказів' then 70
    when 'сумнівна' then 30
    when 'спростована' then 0
    else 50
  end,
  'legacy_person',
  person.created_by,
  jsonb_build_object('source', 'persons_projection_backfill')
from public.persons person
where not exists (
  select 1 from public.person_names existing
  where existing.person_id = person.id
    and existing.project_id = person.project_id
    and coalesce(existing.metadata ->> 'source', '') like 'persons_projection%'
);

-- A previous deployment may already have created the compatibility projection
-- as non-primary. Repair only persons that currently have no primary at all;
-- no stored spelling is changed.
with missing_primary as (
  select distinct on (name.person_id)
    name.id
  from public.person_names name
  where coalesce(name.metadata ->> 'source', '') like 'persons_projection%'
    and not exists (
      select 1
      from public.person_names current_primary
      where current_primary.person_id = name.person_id
        and current_primary.is_primary
    )
  order by
    name.person_id,
    (name.metadata ->> 'source' = 'persons_projection') desc,
    name.created_at,
    name.id
)
update public.person_names name
set is_primary = true,
    is_preferred = true
from missing_primary candidate
where name.id = candidate.id;

-- Preserve the old free-text fields verbatim on persons and materialize each
-- item as an additional searchable name.  Re-running the migration is safe.
with legacy_values as (
  select distinct on (person.id, btrim(item.value))
    person.project_id,
    person.id person_id,
    person.created_by,
    btrim(item.value) value
  from public.persons person
  cross join lateral pg_catalog.regexp_split_to_table(
    coalesce(person.name_variants, ''),
    '[;,\n\r]+'
  ) item(value)
  where btrim(item.value) <> ''
  order by person.id, btrim(item.value)
)
insert into public.person_names (
  project_id, person_id, name_type, full_name, original_text,
  full_normalized, is_searchable, source_type, created_by, metadata
)
select
  legacy.project_id,
  legacy.person_id,
  'alias',
  legacy.value,
  legacy.value,
  legacy.value,
  true,
  'legacy_name_variants',
  legacy.created_by,
  jsonb_build_object('source', 'persons.name_variants_backfill')
from legacy_values legacy
where not exists (
  select 1
  from public.person_names existing
  where existing.person_id = legacy.person_id
    and btrim(coalesce(nullif(existing.original_text, ''), existing.full_name)) = legacy.value
);

with legacy_values as (
  select distinct on (person.id, btrim(item.value))
    person.project_id,
    person.id person_id,
    person.given_name,
    person.patronymic,
    person.created_by,
    btrim(item.value) value
  from public.persons person
  cross join lateral pg_catalog.regexp_split_to_table(
    coalesce(person.surname_variants, ''),
    '[;,\n\r]+'
  ) item(value)
  where btrim(item.value) <> ''
  order by person.id, btrim(item.value)
)
insert into public.person_names (
  project_id, person_id, name_type, surname, given_name, patronymic,
  full_name, original_text, full_normalized, is_searchable,
  source_type, created_by, metadata
)
select
  legacy.project_id,
  legacy.person_id,
  'surname_variant',
  legacy.value,
  legacy.given_name,
  legacy.patronymic,
  btrim(legacy.value || ' ' || legacy.given_name || ' ' || legacy.patronymic),
  legacy.value,
  btrim(legacy.value || ' ' || legacy.given_name || ' ' || legacy.patronymic),
  true,
  'legacy_surname_variants',
  legacy.created_by,
  jsonb_build_object('source', 'persons.surname_variants_backfill')
from legacy_values legacy
where not exists (
  select 1
  from public.person_names existing
  where existing.person_id = legacy.person_id
    and existing.name_type = 'surname_variant'
    and btrim(existing.surname) = legacy.value
);

insert into public.person_names (
  project_id, person_id, name_type, surname, given_name, patronymic,
  maiden_surname, full_name, original_text, full_normalized,
  is_searchable, source_type, created_by, metadata
)
select
  person.project_id,
  person.id,
  'birth',
  person.custom_fields ->> '__trackerRoduMaidenSurname',
  person.given_name,
  person.patronymic,
  person.custom_fields ->> '__trackerRoduMaidenSurname',
  btrim((person.custom_fields ->> '__trackerRoduMaidenSurname') || ' ' || person.given_name || ' ' || person.patronymic),
  btrim((person.custom_fields ->> '__trackerRoduMaidenSurname') || ' ' || person.given_name || ' ' || person.patronymic),
  btrim((person.custom_fields ->> '__trackerRoduMaidenSurname') || ' ' || person.given_name || ' ' || person.patronymic),
  true,
  'legacy_maiden_surname',
  person.created_by,
  jsonb_build_object('source', 'persons.custom_fields.maiden_surname_backfill')
from public.persons person
where nullif(btrim(person.custom_fields ->> '__trackerRoduMaidenSurname'), '') is not null
  and not exists (
    select 1
    from public.person_names existing
    where existing.person_id = person.id
      and existing.name_type = 'birth'
      and btrim(existing.surname) = btrim(person.custom_fields ->> '__trackerRoduMaidenSurname')
  );

-- Fill derived search fields only after metadata and compatibility rows have
-- been materialized, so mixed-version values participate in search too.
update public.person_names name
set
  original_tokens = public.person_name_search_tokens_v1(name.original_text),
  normalized_tokens = public.person_name_search_tokens_v1(name.full_normalized),
  transliteration_tokens = public.person_name_search_tokens_v1(
    public.person_name_search_transliterate_v1(
      name.original_text || ' ' || name.full_normalized || ' ' || name.surname || ' ' ||
      name.maiden_surname || ' ' || name.given_name || ' ' || name.patronymic || ' ' || name.nickname
    )
  ),
  simplified_tokens = public.person_name_search_tokens_v1(
    name.original_text || ' ' || name.full_normalized || ' ' || name.surname || ' ' ||
    name.maiden_surname || ' ' || name.given_name || ' ' || name.patronymic || ' ' || name.nickname
  ),
  search_text = public.person_name_search_normalize_v1(
    name.original_text || ' ' || name.full_normalized || ' ' || name.surname || ' ' ||
    name.maiden_surname || ' ' || name.given_name || ' ' || name.patronymic || ' ' || name.nickname
  ) || ' ' || public.person_name_search_transliterate_v1(
    name.original_text || ' ' || name.full_normalized || ' ' || name.surname || ' ' ||
    name.maiden_surname || ' ' || name.given_name || ' ' || name.patronymic || ' ' || name.nickname
  );

-- Restore the timestamp behavior only after migration-owned enrichment is
-- finished, so pre-existing updated_at values are not rewritten as user edits.
create trigger person_names_set_updated_at
before update on public.person_names
for each row execute function public.set_updated_at();

-- Editors may add non-primary variants directly, but the display-primary
-- invariant is changed only by the transaction-safe RPC below. Internal
-- projection triggers and parent cascades continue to work as before.
create or replace function security_private.guard_historical_person_name_primary_v1()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  -- API writes run as `authenticated` and can never change the primary flag
  -- directly. Trusted mutations execute inside private SECURITY DEFINER
  -- helpers, whose database role is not user-selectable or GUC-spoofable.
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' and new.is_primary then
    raise exception 'PERSON_NAME_PRIMARY_DIRECT_CHANGE_FORBIDDEN' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and row(old.project_id, old.person_id)
    is distinct from row(new.project_id, new.person_id) then
    raise exception 'PERSON_NAME_IDENTITY_MOVE_FORBIDDEN' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and old.is_primary is distinct from new.is_primary then
    raise exception 'PERSON_NAME_PRIMARY_DIRECT_CHANGE_FORBIDDEN' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' and old.is_primary then
    -- During a foreign-key cascade the parent is already absent. Allow the
    -- cleanup instead of blocking deletion of a Person or an entire Project.
    if not exists (
      select 1 from public.projects project where project.id = old.project_id
    ) or not exists (
      select 1 from public.persons person
      where person.id = old.person_id and person.project_id = old.project_id
    ) then
      return old;
    end if;
    raise exception 'PERSON_NAME_PRIMARY_DELETE_FORBIDDEN' using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

drop trigger if exists person_names_05_guard_primary on public.person_names;
create trigger person_names_05_guard_primary
before insert or update or delete on public.person_names
for each row execute function security_private.guard_historical_person_name_primary_v1();

revoke all on function security_private.guard_historical_person_name_primary_v1()
  from public, anon, authenticated, service_role;

create or replace function security_private.prepare_historical_person_name_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $function$
declare
  all_name_text text;
  v2_metadata jsonb;
  v2_metadata_changed boolean;
  exact_restore boolean := false;
begin
  -- Only the private restore RPC can create this marker. Returning NEW here
  -- later preserves backed-up core values byte-for-byte; restore calculates
  -- the derived search columns itself after validating the complete payload.
  exact_restore := exists (
    select 1
    from security_private.person_name_restore_context context
    where context.transaction_id = pg_catalog.txid_current()
      and context.backend_pid = pg_catalog.pg_backend_pid()
      and context.project_id = new.project_id
  );

  if not exact_restore then
    if tg_op = 'UPDATE' then
      new.lock_version := old.lock_version + 1;
    end if;

  -- A newly deployed database can briefly be served by an older PostgREST
  -- schema cache. During that window the client deliberately falls back to
  -- legacy columns and carries every V2 value in metadata. Reconcile that
  -- envelope here so the write is durable and searchable as soon as it reaches
  -- PostgreSQL. Exact original_text is intentionally not part of this block.
  v2_metadata := case
    when pg_catalog.jsonb_typeof(new.metadata -> 'tracker_person_name_v2') = 'object'
      then new.metadata -> 'tracker_person_name_v2'
    else '{}'::jsonb
  end;
  if tg_op = 'INSERT' then
    v2_metadata_changed := true;
  else
    v2_metadata_changed := (new.metadata -> 'tracker_person_name_v2')
      is distinct from (old.metadata -> 'tracker_person_name_v2');
  end if;

  if v2_metadata_changed then
    if v2_metadata ->> 'nameType' ~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
      new.name_type := v2_metadata ->> 'nameType';
    end if;
    if v2_metadata ? 'maidenSurname' then
      new.maiden_surname := coalesce(v2_metadata ->> 'maidenSurname', '');
    end if;
    if v2_metadata ? 'prefix' then
      new.prefix := coalesce(v2_metadata ->> 'prefix', '');
    end if;
    if v2_metadata ? 'suffix' then
      new.suffix := coalesce(v2_metadata ->> 'suffix', '');
    end if;
    if v2_metadata ? 'nickname' then
      new.nickname := coalesce(v2_metadata ->> 'nickname', '');
    end if;
    if v2_metadata ? 'fullNormalized' then
      new.full_normalized := coalesce(v2_metadata ->> 'fullNormalized', '');
    end if;
    if v2_metadata ? 'orthography' then
      new.orthography := coalesce(v2_metadata ->> 'orthography', '');
    end if;
    if v2_metadata ? 'validFrom' then
      new.valid_from := nullif(v2_metadata ->> 'validFrom', '');
    end if;
    if v2_metadata ? 'validTo' then
      new.valid_to := nullif(v2_metadata ->> 'validTo', '');
    end if;
    if v2_metadata ->> 'datePrecision' = any (array[
      'exact', 'day', 'month', 'year', 'range', 'circa',
      'before', 'after', 'between', 'unknown'
    ]::text[]) then
      new.date_precision := v2_metadata ->> 'datePrecision';
    end if;
    if pg_catalog.jsonb_typeof(v2_metadata -> 'isSearchable') = 'boolean' then
      new.is_searchable := (v2_metadata ->> 'isSearchable')::boolean;
    end if;
    if v2_metadata ? 'sourceType' then
      new.source_type := coalesce(nullif(v2_metadata ->> 'sourceType', ''), 'manual');
    end if;
    if v2_metadata ? 'sourceId' then
      new.source_id := case
        when v2_metadata ->> 'sourceId' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (v2_metadata ->> 'sourceId')::uuid
        else null
      end;
    end if;
    if v2_metadata ? 'citationId' then
      new.citation_id := case
        when v2_metadata ->> 'citationId' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (v2_metadata ->> 'citationId')::uuid
        else null
      end;
    end if;
    if v2_metadata ? 'documentFragmentId' then
      new.document_fragment_id := case
        when v2_metadata ->> 'documentFragmentId' ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (v2_metadata ->> 'documentFragmentId')::uuid
        else null
      end;
    end if;
  end if;

  if new.created_by is null then
    new.created_by := coalesce(
      auth.uid(),
      (select person.created_by from public.persons person
       where person.id = new.person_id and person.project_id = new.project_id)
    );
  end if;

  new.full_normalized := coalesce(
    nullif(new.full_normalized, ''),
    nullif(new.full_name, ''),
    nullif(btrim(new.surname || ' ' || new.given_name || ' ' || new.patronymic), ''),
    ''
  );
  new.source_type := case
    when new.source_finding_id is not null then 'finding'
    when new.source_document_id is not null then 'document'
    else coalesce(nullif(new.source_type, ''), 'manual')
  end;
    new.source_id := case
      when new.source_finding_id is not null then new.source_finding_id
      when new.source_document_id is not null then new.source_document_id
      else new.source_id
    end;
  end if;

  -- A UUID is not sufficient provenance on its own: every concrete source
  -- must belong to the same project as the PersonName. SECURITY DEFINER is
  -- intentional here so the invariant does not depend on the caller's RLS
  -- visibility into the source table.
  if new.source_document_id is not null then
    perform 1
    from public.documents document
    where document.id = new.source_document_id
      and document.project_id = new.project_id
    for key share;
    if not found then
      raise exception 'PERSON_NAME_SOURCE_DOCUMENT_PROJECT_MISMATCH'
        using errcode = '23503';
    end if;
  end if;
  if new.source_finding_id is not null then
    perform 1
    from public.findings finding
    where finding.id = new.source_finding_id
      and finding.project_id = new.project_id
    for key share;
    if not found then
      raise exception 'PERSON_NAME_SOURCE_FINDING_PROJECT_MISMATCH'
        using errcode = '23503';
    end if;
  end if;
  if new.source_type = 'document' and new.source_id is not null then
    perform 1
    from public.documents document
    where document.id = new.source_id
      and document.project_id = new.project_id
    for key share;
    if not found then
      raise exception 'PERSON_NAME_SOURCE_DOCUMENT_PROJECT_MISMATCH'
        using errcode = '23503';
    end if;
  end if;
  if new.source_type = 'finding' and new.source_id is not null then
    perform 1
    from public.findings finding
    where finding.id = new.source_id
      and finding.project_id = new.project_id
    for key share;
    if not found then
      raise exception 'PERSON_NAME_SOURCE_FINDING_PROJECT_MISMATCH'
        using errcode = '23503';
    end if;
  end if;

  if exact_restore then
    return new;
  end if;

  all_name_text :=
    new.original_text || ' ' || new.full_normalized || ' ' || new.full_name || ' ' ||
    new.prefix || ' ' || new.surname || ' ' || new.maiden_surname || ' ' ||
    new.given_name || ' ' || new.patronymic || ' ' || new.nickname || ' ' || new.suffix;
  new.original_tokens := public.person_name_search_tokens_v1(new.original_text);
  new.normalized_tokens := public.person_name_search_tokens_v1(new.full_normalized);
  new.transliteration_tokens := public.person_name_search_tokens_v1(
    public.person_name_search_transliterate_v1(all_name_text)
  );
  new.simplified_tokens := public.person_name_search_tokens_v1(all_name_text);
  new.search_text := public.person_name_search_normalize_v1(all_name_text) || ' ' ||
    public.person_name_search_transliterate_v1(all_name_text);
  return new;
end;
$function$;

drop trigger if exists person_names_10_prepare_historical on public.person_names;
create trigger person_names_10_prepare_historical
before insert or update on public.person_names
for each row execute function security_private.prepare_historical_person_name_v1();

revoke all on function security_private.prepare_historical_person_name_v1()
  from public, anon, authenticated, service_role;

-- Generic source_id mirrors the concrete FK when a name is linked to a
-- Document/Finding. Clear both sides before the parent's ON DELETE SET NULL
-- action so the prepare trigger never sees a dangling generic UUID. The type
-- is retained as provenance (a document/finding once existed), only its link is
-- removed.
create or replace function security_private.detach_person_name_document_source_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  update public.person_names name
  set
    source_document_id = case
      when name.source_document_id = old.id then null
      else name.source_document_id
    end,
    source_id = case
      when name.source_type = 'document' and name.source_id = old.id then null
      else name.source_id
    end,
    metadata = case
      when name.metadata #>> '{tracker_person_name_v2,sourceType}' = 'document'
        and name.metadata #>> '{tracker_person_name_v2,sourceId}' = old.id::text
        then name.metadata #- '{tracker_person_name_v2,sourceId}'
      else name.metadata
    end
  where name.project_id = old.project_id
    and (
      name.source_document_id = old.id
      or (name.source_type = 'document' and name.source_id = old.id)
    );
  return old;
end;
$function$;

drop trigger if exists person_names_detach_document_source on public.documents;
create trigger person_names_detach_document_source
before delete on public.documents
for each row execute function security_private.detach_person_name_document_source_v1();

revoke all on function security_private.detach_person_name_document_source_v1()
  from public, anon, authenticated, service_role;

create or replace function security_private.detach_person_name_finding_source_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  update public.person_names name
  set
    source_finding_id = case
      when name.source_finding_id = old.id then null
      else name.source_finding_id
    end,
    source_id = case
      when name.source_type = 'finding' and name.source_id = old.id then null
      else name.source_id
    end,
    metadata = case
      when name.metadata #>> '{tracker_person_name_v2,sourceType}' = 'finding'
        and name.metadata #>> '{tracker_person_name_v2,sourceId}' = old.id::text
        then name.metadata #- '{tracker_person_name_v2,sourceId}'
      else name.metadata
    end
  where name.project_id = old.project_id
    and (
      name.source_finding_id = old.id
      or (name.source_type = 'finding' and name.source_id = old.id)
    );
  return old;
end;
$function$;

drop trigger if exists person_names_detach_finding_source on public.findings;
create trigger person_names_detach_finding_source
before delete on public.findings
for each row execute function security_private.detach_person_name_finding_source_v1();

revoke all on function security_private.detach_person_name_finding_source_v1()
  from public, anon, authenticated, service_role;

-- The legacy persons trigger must own only its dedicated projection row.
-- Historical/manual names may be primary for display, but editing persons must
-- never select and overwrite such a row. Existing projection original_text is
-- also left byte-for-byte unchanged.
create or replace function public.family_tree_sync_person_projection()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  projection_name_id uuid;
  has_primary_name boolean;
  person_full_name text;
  person_evidence_status text;
begin
  person_full_name := nullif(pg_catalog.btrim(new.full_name), '');
  if person_full_name is null then
    person_full_name := nullif(pg_catalog.btrim(pg_catalog.concat_ws(
      ' ', new.surname, new.given_name, new.patronymic
    )), '');
  end if;
  person_full_name := coalesce(person_full_name, '');
  person_evidence_status := case new.status
    when 'доведена' then 'proven'
    when 'відома особисто' then 'proven'
    when 'відома документально' then 'proven'
    when 'частково доведена' then 'likely'
    when 'відома з переказів' then 'likely'
    when 'сумнівна' then 'disputed'
    when 'спростована' then 'disproven'
    else 'unknown'
  end;

  select name.id
    into projection_name_id
  from public.person_names name
  where name.person_id = new.id
    and name.project_id = new.project_id
    and coalesce(name.metadata ->> 'source', '') like 'persons_projection%'
  order by
    (name.metadata ->> 'source' = 'persons_projection') desc,
    name.created_at,
    name.id
  limit 1;

  select exists (
    select 1
    from public.person_names name
    where name.person_id = new.id
      and name.project_id = new.project_id
      and name.is_primary
  ) into has_primary_name;

  if projection_name_id is null then
    insert into public.person_names (
      project_id,
      person_id,
      name_type,
      language_code,
      script_code,
      surname,
      given_name,
      patronymic,
      full_name,
      original_text,
      full_normalized,
      is_primary,
      is_preferred,
      evidence_status,
      confidence,
      source_type,
      created_by,
      metadata
    ) values (
      new.project_id,
      new.id,
      'primary',
      'uk',
      'Cyrl',
      coalesce(new.surname, ''),
      coalesce(new.given_name, ''),
      coalesce(new.patronymic, ''),
      person_full_name,
      person_full_name,
      person_full_name,
      not has_primary_name,
      not has_primary_name,
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      'legacy_person',
      new.created_by,
      pg_catalog.jsonb_build_object('source', 'persons_projection')
    );
  else
    update public.person_names name
      set surname = coalesce(new.surname, ''),
          given_name = coalesce(new.given_name, ''),
          patronymic = coalesce(new.patronymic, ''),
          full_name = person_full_name,
          full_normalized = person_full_name,
          is_primary = case when has_primary_name then name.is_primary else true end,
          is_preferred = case when has_primary_name then name.is_preferred else true end,
          evidence_status = person_evidence_status,
          confidence = public.family_tree_confidence_for_evidence(person_evidence_status),
          source_type = 'legacy_person',
          created_by = coalesce(name.created_by, new.created_by),
          metadata = coalesce(name.metadata, '{}'::jsonb) ||
            pg_catalog.jsonb_build_object('source', 'persons_projection'),
          updated_at = pg_catalog.now()
    where name.id = projection_name_id;
  end if;

  delete from public.person_timeline_events
  where person_id = new.id
    and metadata ->> 'source' = 'persons_projection';

  if coalesce(new.birth_date, '') <> ''
    or coalesce(new.birth_year_from, '') <> ''
    or coalesce(new.birth_year_to, '') <> ''
    or coalesce(new.birth_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id, person_id, event_type, title, event_date, date_from,
      date_to, date_text, place_name, event_role, evidence_status,
      confidence, metadata
    ) values (
      new.project_id,
      new.id,
      'birth',
      'Народження',
      coalesce(new.birth_date, ''),
      coalesce(new.birth_year_from, ''),
      coalesce(new.birth_year_to, ''),
      coalesce(
        nullif(new.birth_date, ''),
        pg_catalog.concat_ws('–', nullif(new.birth_year_from, ''), nullif(new.birth_year_to, ''))
      ),
      coalesce(new.birth_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      pg_catalog.jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.marriage_date, '') <> ''
    or coalesce(new.marriage_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id, person_id, event_type, title, event_date, date_text,
      place_name, event_role, evidence_status, confidence, metadata
    ) values (
      new.project_id,
      new.id,
      'marriage',
      'Шлюб',
      coalesce(new.marriage_date, ''),
      coalesce(new.marriage_date, ''),
      coalesce(new.marriage_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      pg_catalog.jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.death_date, '') <> ''
    or coalesce(new.death_year_from, '') <> ''
    or coalesce(new.death_year_to, '') <> ''
    or coalesce(new.death_place, '') <> '' then
    insert into public.person_timeline_events (
      project_id, person_id, event_type, title, event_date, date_from,
      date_to, date_text, place_name, event_role, evidence_status,
      confidence, metadata
    ) values (
      new.project_id,
      new.id,
      'death',
      'Смерть',
      coalesce(new.death_date, ''),
      coalesce(new.death_year_from, ''),
      coalesce(new.death_year_to, ''),
      coalesce(
        nullif(new.death_date, ''),
        pg_catalog.concat_ws('–', nullif(new.death_year_from, ''), nullif(new.death_year_to, ''))
      ),
      coalesce(new.death_place, ''),
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      pg_catalog.jsonb_build_object('source', 'persons_projection')
    );
  end if;

  if coalesce(new.residence_places, '') <> '' then
    insert into public.person_timeline_events (
      project_id, person_id, event_type, title, place_name, event_role,
      evidence_status, confidence, metadata
    ) values (
      new.project_id,
      new.id,
      'residence',
      'Місце проживання',
      new.residence_places,
      'subject',
      person_evidence_status,
      public.family_tree_confidence_for_evidence(person_evidence_status),
      pg_catalog.jsonb_build_object('source', 'persons_projection')
    );
  end if;

  return new;
end;
$function$;

revoke all on function public.family_tree_sync_person_projection()
  from public, anon, authenticated;

create index if not exists person_names_search_text_trgm_idx
  on public.person_names using gin (search_text extensions.gin_trgm_ops)
  where is_searchable;
create index if not exists person_names_project_normalized_idx
  on public.person_names (project_id, public.person_name_search_normalize_v1(full_normalized))
  where is_searchable;
create index if not exists person_names_valid_period_idx
  on public.person_names (person_id, valid_from, valid_to)
  where valid_from is not null or valid_to is not null;
create index if not exists person_names_citation_idx
  on public.person_names (citation_id)
  where citation_id is not null;
create index if not exists person_names_document_fragment_idx
  on public.person_names (document_fragment_id)
  where document_fragment_id is not null;

create table if not exists security_private.person_name_audit_log (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  person_id uuid not null references public.persons(id) on delete cascade,
  person_name_id uuid not null,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (action in (
    'created', 'updated', 'deleted', 'set_primary',
    'source_changed', 'valid_period_changed'
  )),
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz not null default now()
);

comment on table security_private.person_name_audit_log is
  'Private per-name history retained while its Person exists. It is intentionally removed by Person or Project cascade deletion so account and project erasure remains complete.';

create index if not exists person_name_audit_person_created_idx
  on security_private.person_name_audit_log (person_id, created_at desc, id desc);

revoke all on security_private.person_name_audit_log
  from public, anon, authenticated;
grant all on security_private.person_name_audit_log to service_role;
grant usage, select on sequence security_private.person_name_audit_log_id_seq
  to service_role;

create or replace function security_private.audit_historical_person_name_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  action_code text;
  before_payload jsonb;
  after_payload jsonb;
  audit_project_id uuid;
  audit_person_id uuid;
  audit_person_name_id uuid;
  audit_actor_id uuid;
begin
  -- A parent FK cascade must remain deletable. Audit rows have parent foreign
  -- keys of their own, so logging such a child DELETE would otherwise fail and
  -- roll back deletion of the Person or Project.
  if tg_op = 'DELETE' and (
    not exists (
      select 1 from public.projects project where project.id = old.project_id
    ) or not exists (
      select 1 from public.persons person
      where person.id = old.person_id and person.project_id = old.project_id
    )
  ) then
    return old;
  end if;

  if tg_op = 'INSERT' then
    action_code := 'created';
  elsif tg_op = 'DELETE' then
    action_code := 'deleted';
  elsif old.is_primary is distinct from new.is_primary and new.is_primary then
    action_code := 'set_primary';
  elsif row(
    old.source_type, old.source_id, old.source_document_id,
    old.source_finding_id, old.citation_id, old.document_fragment_id
  ) is distinct from row(
    new.source_type, new.source_id, new.source_document_id,
    new.source_finding_id, new.citation_id, new.document_fragment_id
  ) then
    action_code := 'source_changed';
  elsif row(old.valid_from, old.valid_to, old.date_precision)
    is distinct from row(new.valid_from, new.valid_to, new.date_precision) then
    action_code := 'valid_period_changed';
  else
    action_code := 'updated';
  end if;

  if tg_op <> 'INSERT' then
    before_payload := to_jsonb(old) - array[
      'original_tokens', 'normalized_tokens', 'transliteration_tokens',
      'simplified_tokens', 'search_text'
    ]::text[];
  end if;
  if tg_op <> 'DELETE' then
    after_payload := to_jsonb(new) - array[
      'original_tokens', 'normalized_tokens', 'transliteration_tokens',
      'simplified_tokens', 'search_text'
    ]::text[];
  end if;

  if tg_op = 'DELETE' then
    audit_project_id := old.project_id;
    audit_person_id := old.person_id;
    audit_person_name_id := old.id;
    audit_actor_id := coalesce(auth.uid(), old.created_by);
  else
    audit_project_id := new.project_id;
    audit_person_id := new.person_id;
    audit_person_name_id := new.id;
    audit_actor_id := coalesce(auth.uid(), new.created_by);
  end if;

  insert into security_private.person_name_audit_log (
    project_id, person_id, person_name_id, actor_id,
    action, before_data, after_data
  ) values (
    audit_project_id,
    audit_person_id,
    audit_person_name_id,
    audit_actor_id,
    action_code,
    before_payload,
    after_payload
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

drop trigger if exists person_names_90_audit_historical on public.person_names;
create trigger person_names_90_audit_historical
after insert or update or delete on public.person_names
for each row execute function security_private.audit_historical_person_name_v1();

revoke all on function security_private.audit_historical_person_name_v1()
  from public, anon, authenticated, service_role;

create or replace function public.search_project_person_names_v1(
  p_project_id uuid,
  p_query text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
declare
  raw_query text := coalesce(p_query, '');
  normalized_query text;
  transliterated_query text;
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or (
    not caller_is_service and not public.is_project_member(p_project_id)
  ) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if char_length(raw_query) > 200 then
    raise exception 'PERSON_NAME_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  normalized_query := public.person_name_search_normalize_v1(raw_query);
  transliterated_query := public.person_name_search_transliterate_v1(raw_query);
  if char_length(normalized_query) < 2 then
    return '[]'::jsonb;
  end if;

  return coalesce((
    with ranked as (
      select
        name.*,
        case
          when name.original_text = raw_query then 0
          when public.person_name_search_normalize_v1(name.original_text) = normalized_query then 1
          when public.person_name_search_normalize_v1(name.full_normalized) = normalized_query then 2
          when not name.is_primary and (
            name.search_text like '%' || normalized_query || '%'
            or name.search_text like '%' || transliterated_query || '%'
          ) then 3
          else 4
        end match_rank,
        greatest(
          extensions.similarity(name.search_text, normalized_query),
          extensions.similarity(name.search_text, transliterated_query)
        ) match_score
      from public.person_names name
      join public.persons person
        on person.id = name.person_id and person.project_id = name.project_id
      where name.project_id = p_project_id
        and name.is_searchable
        and (
          name.search_text like '%' || normalized_query || '%'
          or name.search_text like '%' || transliterated_query || '%'
          or name.search_text % normalized_query
          or name.search_text % transliterated_query
        )
    ), best_per_person as (
      select distinct on (person_id)
        id, person_id, name_type, language_code, script_code, orthography,
        surname, maiden_surname, given_name, patronymic, nickname,
        full_name, original_text, full_normalized, is_primary,
        source_type, source_id, source_document_id, source_finding_id,
        citation_id, document_fragment_id,
        confidence, valid_from, valid_to, date_precision,
        match_rank, match_score
      from ranked
      order by person_id, match_rank, match_score desc, is_primary desc, updated_at desc, id
    )
    select jsonb_agg(jsonb_build_object(
      'personId', result.person_id,
      'personNameId', result.id,
      'displayName', coalesce(
        nullif(display.display_name, ''),
        nullif(result.full_normalized, ''),
        nullif(result.full_name, ''),
        nullif(result.original_text, ''),
        btrim(result.surname || ' ' || result.given_name || ' ' || result.patronymic),
        ''
      ),
      'matchedName', coalesce(
        nullif(result.original_text, ''),
        nullif(result.full_normalized, ''),
        nullif(result.full_name, ''),
        btrim(result.surname || ' ' || result.given_name || ' ' || result.patronymic),
        ''
      ),
      'matchType', case result.match_rank
        when 0 then 'exact'
        when 1 then 'normalized'
        when 2 then 'normalized'
        when 3 then 'variant'
        else 'fuzzy'
      end,
      'score', case result.match_rank
        when 0 then 1::real
        when 1 then 1::real
        when 2 then greatest(0.98::real, result.match_score)
        when 3 then greatest(0.8::real, result.match_score)
        else result.match_score
      end,
      'name', jsonb_build_object(
        'id', result.id,
        'nameType', result.name_type,
        'language', result.language_code,
        'script', result.script_code,
        'orthography', result.orthography,
        'surname', result.surname,
        'maidenSurname', result.maiden_surname,
        'givenName', result.given_name,
        'patronymic', result.patronymic,
        'nickname', result.nickname,
        'fullName', result.full_name,
        'fullOriginal', result.original_text,
        'fullNormalized', result.full_normalized,
        'isPrimary', result.is_primary,
        'sourceType', result.source_type,
        'sourceId', result.source_id,
        'sourceDocumentId', result.source_document_id,
        'sourceFindingId', result.source_finding_id,
        'citationId', result.citation_id,
        'documentFragmentId', result.document_fragment_id,
        'confidence', result.confidence,
        'validFrom', result.valid_from,
        'validTo', result.valid_to,
        'datePrecision', result.date_precision
      )
    ) order by result.match_rank, result.match_score desc, result.person_id)
    from (
      select * from best_per_person
      order by match_rank, match_score desc, person_id
      limit bounded_limit
    ) result
    left join lateral (
      select coalesce(
        nullif(primary_name.full_normalized, ''),
        nullif(primary_name.full_name, ''),
        nullif(primary_name.original_text, ''),
        nullif(btrim(primary_name.surname || ' ' || primary_name.given_name || ' ' || primary_name.patronymic), ''),
        ''
      ) display_name
      from public.person_names primary_name
      where primary_name.project_id = p_project_id
        and primary_name.person_id = result.person_id
        and primary_name.is_primary
      order by primary_name.updated_at desc, primary_name.id
      limit 1
    ) display on true
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.preview_project_person_name_normalization_v1(
  p_project_id uuid,
  p_value text
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  raw_value text := coalesce(p_value, '');
  normalized_value text;
  transliterated_value text;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or (
    not caller_is_service and not public.is_project_member(p_project_id)
  ) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if char_length(raw_value) > 1000 then
    raise exception 'PERSON_NAME_PREVIEW_TOO_LONG' using errcode = '22023';
  end if;

  normalized_value := public.person_name_search_normalize_v1(raw_value);
  transliterated_value := public.person_name_search_transliterate_v1(raw_value);

  return jsonb_build_object(
    'normalized', normalized_value,
    'simplified', normalized_value,
    'transliteration', transliterated_value,
    'tokens', jsonb_build_object(
      'original', public.person_name_search_tokens_v1(raw_value),
      'normalized', public.person_name_search_tokens_v1(normalized_value),
      'simplified', public.person_name_search_tokens_v1(normalized_value),
      'transliteration', public.person_name_search_tokens_v1(transliterated_value)
    )
  );
end;
$function$;

create or replace function security_private.set_project_person_name_primary_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_name_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  target_name public.person_names%rowtype;
  display_name text;
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if auth.uid() is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null or (
    not caller_is_service and not public.can_edit_project(p_project_id)
  ) then
    raise exception 'PROJECT_EDIT_REQUIRED' using errcode = '42501';
  end if;

  perform 1
  from public.persons person
  where person.project_id = p_project_id and person.id = p_person_id
  for update;
  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select name.* into target_name
  from public.person_names name
  where name.project_id = p_project_id
    and name.person_id = p_person_id
    and name.id = p_name_id
  for update;
  if not found then
    raise exception 'PERSON_NAME_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.person_names name
  set is_primary = false
  where name.project_id = p_project_id
    and name.person_id = p_person_id
    and name.is_primary
    and name.id <> p_name_id;

  update public.person_names name
  set is_primary = true,
      is_preferred = true
  where name.id = p_name_id
  returning name.* into target_name;

  display_name := coalesce(
    nullif(target_name.full_normalized, ''),
    nullif(target_name.full_name, ''),
    nullif(btrim(target_name.surname || ' ' || target_name.given_name || ' ' || target_name.patronymic), ''),
    nullif(target_name.original_text, ''),
    ''
  );

  -- Primary is a display preference inside person_names. Legacy persons fields
  -- are deliberately unchanged so older clients and existing user data keep
  -- exactly the same values.

  return jsonb_build_object(
    'personId', p_person_id,
    'personNameId', p_name_id,
    'displayName', display_name,
    'lockVersion', target_name.lock_version
  );
end;
$function$;

revoke all on function security_private.set_project_person_name_primary_v1(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.set_project_person_name_primary_v1(uuid,uuid,uuid)
  to authenticated, service_role;

create or replace function public.set_project_person_name_primary_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_name_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.set_project_person_name_primary_v1($1, $2, $3);
$wrapper$;

create or replace function security_private.preflight_project_person_names_restore_v1(
  p_project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  actor_id uuid := auth.uid();
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
begin
  if actor_id is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not caller_is_service and not public.is_project_owner(p_project_id) then
    raise exception 'PROJECT_RESTORE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return pg_catalog.jsonb_build_object(
    'projectId', p_project_id,
    'contract', 'historical-person-names-backup-v1'
  );
end;
$function$;

revoke all on function security_private.preflight_project_person_names_restore_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.preflight_project_person_names_restore_v1(uuid)
  to authenticated, service_role;

create or replace function public.preflight_project_person_names_restore_v1(
  p_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.preflight_project_person_names_restore_v1($1);
$wrapper$;

-- Backup restore is a single trusted replacement statement. It restores the
-- complete collection (including the persons_projection row and its primary
-- flag) without follow-up updates that would rewrite timestamps or versions.
create or replace function security_private.restore_project_person_names_v1(
  p_project_id uuid,
  p_names jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '60s'
set lock_timeout = '5s'
as $function$
declare
  actor_id uuid := auth.uid();
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  restored_count integer := 0;
begin
  if actor_id is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not caller_is_service and not public.is_project_owner(p_project_id) then
    raise exception 'PROJECT_RESTORE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_names is null or pg_catalog.jsonb_typeof(p_names) <> 'array' then
    raise exception 'PERSON_NAMES_BACKUP_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_names) item
    where pg_catalog.jsonb_typeof(item) <> 'object'
  ) then
    raise exception 'PERSON_NAMES_BACKUP_INVALID' using errcode = '22023';
  end if;

  -- Lock the project parent before checking its complete Person set. New
  -- Person inserts must take a foreign-key KEY SHARE lock and therefore cannot
  -- appear between completeness validation and the replacement below.
  perform 1
  from public.projects project
  where project.id = p_project_id
  for update;
  if not found then
    raise exception 'PROJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(id uuid, person_id uuid)
    where restored.id is null or restored.person_id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_ID_REQUIRED' using errcode = '22023';
  end if;
  if exists (
    select restored.id
    from pg_catalog.jsonb_to_recordset(p_names) as restored(id uuid)
    group by restored.id
    having count(*) > 1
  ) then
    raise exception 'PERSON_NAMES_BACKUP_DUPLICATE_ID' using errcode = '23505';
  end if;
  if exists (
    select restored.person_id
    from pg_catalog.jsonb_to_recordset(p_names) as restored(person_id uuid, is_primary boolean)
    group by restored.person_id
    having count(*) filter (where restored.is_primary) > 1
  ) then
    raise exception 'PERSON_NAMES_BACKUP_MULTIPLE_PRIMARY' using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.persons person
    left join (
      select
        restored.person_id,
        count(*) filter (where restored.is_primary) as primary_count
      from pg_catalog.jsonb_to_recordset(p_names) as restored(
        person_id uuid,
        is_primary boolean
      )
      group by restored.person_id
    ) restored_primary on restored_primary.person_id = person.id
    where person.project_id = p_project_id
      and coalesce(restored_primary.primary_count, 0) <> 1
  ) then
    raise exception 'PERSON_NAMES_BACKUP_PRIMARY_REQUIRED' using errcode = '23503';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(person_id uuid)
    left join public.persons person
      on person.id = restored.person_id and person.project_id = p_project_id
    where person.id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_PERSON_NOT_FOUND' using errcode = '23503';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(source_document_id uuid)
    left join public.documents document
      on document.id = restored.source_document_id and document.project_id = p_project_id
    where restored.source_document_id is not null and document.id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_DOCUMENT_NOT_FOUND' using errcode = '23503';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(source_finding_id uuid)
    left join public.findings finding
      on finding.id = restored.source_finding_id and finding.project_id = p_project_id
    where restored.source_finding_id is not null and finding.id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_FINDING_NOT_FOUND' using errcode = '23503';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(source_type text, source_id uuid)
    left join public.documents document
      on document.id = restored.source_id and document.project_id = p_project_id
    where restored.source_type = 'document'
      and restored.source_id is not null
      and document.id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_DOCUMENT_NOT_FOUND' using errcode = '23503';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_names) as restored(source_type text, source_id uuid)
    left join public.findings finding
      on finding.id = restored.source_id and finding.project_id = p_project_id
    where restored.source_type = 'finding'
      and restored.source_id is not null
      and finding.id is null
  ) then
    raise exception 'PERSON_NAMES_BACKUP_FINDING_NOT_FOUND' using errcode = '23503';
  end if;

  -- Lock referenced parents first, in deterministic order. A concurrent
  -- Person/Document/Finding deletion can otherwise hold its parent row while
  -- waiting for a cascading write to person_names, producing a lock cycle.
  perform 1
  from public.persons person
  where person.project_id = p_project_id
    and person.id in (
      select restored.person_id
      from pg_catalog.jsonb_to_recordset(p_names) as restored(person_id uuid)
    )
  order by person.id
  for key share;

  perform 1
  from public.documents document
  where document.project_id = p_project_id
    and document.id in (
      select restored.source_document_id
      from pg_catalog.jsonb_to_recordset(p_names) as restored(source_document_id uuid)
      where restored.source_document_id is not null
      union
      select restored.source_id
      from pg_catalog.jsonb_to_recordset(p_names) as restored(source_type text, source_id uuid)
      where restored.source_type = 'document' and restored.source_id is not null
    )
  order by document.id
  for key share;

  perform 1
  from public.findings finding
  where finding.project_id = p_project_id
    and finding.id in (
      select restored.source_finding_id
      from pg_catalog.jsonb_to_recordset(p_names) as restored(source_finding_id uuid)
      where restored.source_finding_id is not null
      union
      select restored.source_id
      from pg_catalog.jsonb_to_recordset(p_names) as restored(source_type text, source_id uuid)
      where restored.source_type = 'finding' and restored.source_id is not null
    )
  order by finding.id
  for key share;

  -- Serialize person-name DML for the short exact replacement without
  -- blocking SELECT. Parent rows are already protected above.
  lock table public.person_names in share row exclusive mode;

  -- Mark only this trusted transaction/project as an exact restore. The table
  -- lock above prevents overlapping person-name writes while keeping readers
  -- and unrelated application tables available.
  insert into security_private.person_name_restore_context (
    transaction_id, backend_pid, project_id
  ) values (
    pg_catalog.txid_current(), pg_catalog.pg_backend_pid(), p_project_id
  ) on conflict do nothing;

  delete from public.person_names name
  where name.project_id = p_project_id;

  with inserted as (
    insert into public.person_names (
      id, project_id, person_id, name_type, language_code, script_code,
      surname, maiden_surname, given_name, patronymic, prefix, suffix,
      nickname, full_name, full_normalized, original_text, orthography,
      valid_from, valid_to, date_precision, is_primary, is_preferred,
      is_searchable, evidence_status, confidence, source_document_id,
      source_finding_id, source_type, source_id, citation_id,
      document_fragment_id, notes, metadata, created_by, lock_version,
      created_at, updated_at, original_tokens, normalized_tokens,
      transliteration_tokens, simplified_tokens, phonetic_key, search_text
    )
    select
      restored.id,
      p_project_id,
      restored.person_id,
      restored.name_type,
      restored.language_code,
      restored.script_code,
      restored.surname,
      restored.maiden_surname,
      restored.given_name,
      restored.patronymic,
      restored.prefix,
      restored.suffix,
      restored.nickname,
      restored.full_name,
      restored.full_normalized,
      restored.original_text,
      restored.orthography,
      restored.valid_from,
      restored.valid_to,
      restored.date_precision,
      restored.is_primary,
      restored.is_preferred,
      restored.is_searchable,
      restored.evidence_status,
      restored.confidence,
      restored.source_document_id,
      restored.source_finding_id,
      restored.source_type,
      restored.source_id,
      restored.citation_id,
      restored.document_fragment_id,
      restored.notes,
      restored.metadata,
      restored.created_by,
      restored.lock_version,
      restored.created_at,
      restored.updated_at,
      public.person_name_search_tokens_v1(restored.original_text),
      public.person_name_search_tokens_v1(restored.full_normalized),
      public.person_name_search_tokens_v1(
        public.person_name_search_transliterate_v1(pg_catalog.concat_ws(
          ' ', restored.original_text, restored.full_normalized,
          restored.full_name, restored.prefix, restored.surname,
          restored.maiden_surname, restored.given_name,
          restored.patronymic, restored.nickname, restored.suffix
        ))
      ),
      public.person_name_search_tokens_v1(pg_catalog.concat_ws(
        ' ', restored.original_text, restored.full_normalized,
        restored.full_name, restored.prefix, restored.surname,
        restored.maiden_surname, restored.given_name,
        restored.patronymic, restored.nickname, restored.suffix
      )),
      ''::text,
      public.person_name_search_normalize_v1(pg_catalog.concat_ws(
        ' ', restored.original_text, restored.full_normalized,
        restored.full_name, restored.prefix, restored.surname,
        restored.maiden_surname, restored.given_name,
        restored.patronymic, restored.nickname, restored.suffix
      )) || ' ' || public.person_name_search_transliterate_v1(pg_catalog.concat_ws(
        ' ', restored.original_text, restored.full_normalized,
        restored.full_name, restored.prefix, restored.surname,
        restored.maiden_surname, restored.given_name,
        restored.patronymic, restored.nickname, restored.suffix
      ))
    from pg_catalog.jsonb_to_recordset(p_names) as restored(
      id uuid,
      person_id uuid,
      name_type text,
      language_code text,
      script_code text,
      surname text,
      maiden_surname text,
      given_name text,
      patronymic text,
      prefix text,
      suffix text,
      nickname text,
      full_name text,
      full_normalized text,
      original_text text,
      orthography text,
      valid_from text,
      valid_to text,
      date_precision text,
      is_primary boolean,
      is_preferred boolean,
      is_searchable boolean,
      evidence_status text,
      confidence integer,
      source_document_id uuid,
      source_finding_id uuid,
      source_type text,
      source_id uuid,
      citation_id uuid,
      document_fragment_id uuid,
      notes text,
      metadata jsonb,
      created_by uuid,
      lock_version integer,
      created_at timestamptz,
      updated_at timestamptz
    )
    returning 1
  )
  select count(*)::integer into restored_count from inserted;

  delete from security_private.person_name_restore_context context
  where context.transaction_id = pg_catalog.txid_current()
    and context.backend_pid = pg_catalog.pg_backend_pid()
    and context.project_id = p_project_id;

  return pg_catalog.jsonb_build_object(
    'projectId', p_project_id,
    'restored', restored_count
  );
end;
$function$;

revoke all on function security_private.restore_project_person_names_v1(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function security_private.restore_project_person_names_v1(uuid,jsonb)
  to authenticated, service_role;

create or replace function public.restore_project_person_names_v1(
  p_project_id uuid,
  p_names jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.restore_project_person_names_v1($1, $2);
$wrapper$;

revoke all on function public.search_project_person_names_v1(uuid,text,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.preview_project_person_name_normalization_v1(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_project_person_name_primary_v1(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.restore_project_person_names_v1(uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.preflight_project_person_names_restore_v1(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.search_project_person_names_v1(uuid,text,integer)
  to authenticated, service_role;
grant execute on function public.preview_project_person_name_normalization_v1(uuid,text)
  to authenticated, service_role;
grant execute on function public.set_project_person_name_primary_v1(uuid,uuid,uuid)
  to authenticated, service_role;
grant execute on function public.restore_project_person_names_v1(uuid,jsonb)
  to authenticated, service_role;
grant execute on function public.preflight_project_person_names_restore_v1(uuid)
  to authenticated, service_role;

-- Re-state the current privacy boundary after adding new columns.  Editors may
-- mutate names; viewers only see names of people they may read exactly.
alter table public.person_names enable row level security;
drop policy if exists person_names_select_members on public.person_names;
create policy person_names_select_members on public.person_names
for select to authenticated
using (public.can_read_exact_family_tree_person(project_id, person_id));

drop policy if exists person_names_insert_editors on public.person_names;
create policy person_names_insert_editors on public.person_names
for insert to authenticated
with check (public.can_edit_project(project_id));

drop policy if exists person_names_update_editors on public.person_names;
create policy person_names_update_editors on public.person_names
for update to authenticated
using (public.can_edit_project(project_id))
with check (public.can_edit_project(project_id));

drop policy if exists person_names_delete_editors on public.person_names;
create policy person_names_delete_editors on public.person_names
for delete to authenticated
using (public.can_edit_project(project_id));

revoke all on public.person_names from public, anon;
grant select, insert, update, delete on public.person_names to authenticated;
grant all on public.person_names to service_role;

commit;
