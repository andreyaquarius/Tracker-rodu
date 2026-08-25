begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

select has_function(
  'public',
  'list_public_zagulyaky_indexing_v1',
  array['text', 'integer', 'text'],
  'the anonymous public SEO indexing facade exists'
);
select has_function(
  'security_private',
  'list_public_zagulyaky_indexing_v1',
  array['text', 'integer', 'text'],
  'the trusted SEO indexing implementation exists outside the Data API schema'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.list_public_zagulyaky_indexing_v1(text,integer,text)'::regprocedure),
  'the public SEO indexing facade is SECURITY INVOKER'
);
select ok(
  (select prosecdef from pg_proc where oid = 'security_private.list_public_zagulyaky_indexing_v1(text,integer,text)'::regprocedure),
  'the private SEO indexing implementation is SECURITY DEFINER'
);
select ok(
  has_function_privilege('anon', 'public.list_public_zagulyaky_indexing_v1(text,integer,text)'::regprocedure, 'EXECUTE')
  and has_function_privilege('anon', 'security_private.list_public_zagulyaky_indexing_v1(text,integer,text)'::regprocedure, 'EXECUTE'),
  'anonymous callers can reach only the public facade through the existing non-exposed trusted schema pattern'
);

insert into public.zagulyaky_records (
  id,
  kind,
  status,
  verification_status,
  privacy_status,
  public_slug,
  title,
  summary,
  original_text,
  normalized_text,
  original_language,
  event_type,
  event_date_text,
  event_year_from,
  event_year_to,
  date_precision,
  source_location_text,
  source_location_normalized,
  found_location_text,
  found_location_normalized,
  possible_living_person,
  published_at
) values
  (
    'd7000000-0000-4000-8000-000000000001',
    'person', 'published', 'verified', 'cleared', 'seo-index-person-a',
    'Анна Індексова', 'Публічний опис Анни.',
    'Оригінальний текст Анни', 'Нормалізований текст Анни', 'uk',
    'birth', '1901 рік', 1901, 1901, 'year',
    'село Оригінальне', 'Село Оригінальне',
    'місто Знайдене', 'Місто Знайдене',
    false, now() - interval '2 days'
  ),
  (
    'd7000000-0000-4000-8000-000000000002',
    'person', 'published', 'plausible', 'cleared', 'seo-index-person-b',
    'Богдан Індексов', 'Публічний опис Богдана.',
    'Оригінальний текст Богдана', 'Нормалізований текст Богдана', 'uk',
    'marriage', '1902 рік', 1902, 1902, 'year',
    null, null, null, null,
    false, now() - interval '1 day'
  ),
  (
    'd7000000-0000-4000-8000-000000000003',
    'person', 'published', 'plausible', 'requires_consent', 'seo-index-person-living',
    'Прихована жива особа', 'Не має бути в індексі.',
    'ПРИВАТНИЙ ТЕКСТ ЖИВОЇ ОСОБИ', '', 'uk',
    null, null, null, null, null,
    null, null, null, null,
    true, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000004',
    'person', 'draft', 'unverified', 'pending', null,
    'Чернетка', 'Не має бути в індексі.',
    'ПРИВАТНА ЧЕРНЕТКА', '', 'uk',
    null, null, null, null, null,
    null, null, null, null,
    false, null
  ),
  (
    'd7000000-0000-4000-8000-000000000005',
    'person', 'published', 'plausible', 'blocked', 'seo-index-person-blocked',
    'Заблокований запис', 'Не має бути в індексі.',
    'ПРИВАТНИЙ ЗАБЛОКОВАНИЙ ТЕКСТ', '', 'uk',
    null, null, null, null, null,
    null, null, null, null,
    false, now()
  ),
  (
    'd7000000-0000-4000-8000-000000000006',
    'document', 'published', 'verified', 'cleared', 'seo-index-document-a',
    'Метрична книга Індексу', 'Публічний опис документа.',
    'Оригінальний текст документа', 'Нормалізований текст документа', 'uk',
    'marriage', '1899–1900 роки', 1899, 1900, 'range',
    'Офіційна місцевість', 'Офіційна місцевість',
    'Знайдена місцевість', 'Знайдена місцевість',
    false, now()
  );

insert into public.zagulyaky_participants (
  id, record_id, role, original_full_name, normalized_uk_full_name,
  residence_text, origin_text, notes, sort_order
) values
  (
    'd7100000-0000-4000-8000-000000000001',
    'd7000000-0000-4000-8000-000000000001', 'subject',
    'Анна Індексова', 'Анна Індексова',
    'ПРИВАТНЕ МІСЦЕ ПРОЖИВАННЯ', 'ПРИВАТНЕ ПОХОДЖЕННЯ', 'ПРИВАТНА НОТАТКА УЧАСНИКА', 0
  ),
  (
    'd7100000-0000-4000-8000-000000000002',
    'd7000000-0000-4000-8000-000000000001', 'subject',
    'Друга Анна', 'Друга Анна',
    null, null, null, 1
  );

insert into public.zagulyaky_sources (
  id, source_type, title, archive_name, citation, page_from, page_to, source_url, metadata
) values (
  'd7200000-0000-4000-8000-000000000001',
  'archive', 'Метрична книга', 'ЦДІАК України', 'ф. 127, оп. 1012, спр. 305',
  '14', '15', 'https://private.example.test/source/305',
  '{"privateToken":"MUST_NOT_LEAK"}'::jsonb
);

insert into public.zagulyaky_record_sources (record_id, source_id, is_primary)
values (
  'd7000000-0000-4000-8000-000000000001',
  'd7200000-0000-4000-8000-000000000001',
  true
);

insert into public.zagulyaky_document_discoveries (
  id, record_id, official_location_text, discovered_location_text,
  record_types, factual_year_from, factual_year_to, page_from, page_to, notes
) values (
  'd7300000-0000-4000-8000-000000000001',
  'd7000000-0000-4000-8000-000000000006',
  'Офіційний опис', 'Знайдений запис',
  array['шлюб', 'метрична книга'], 1899, 1900, '51', '52', 'ПРИВАТНА НОТАТКА ПРО ДОКУМЕНТ'
);

create temporary table pgtap_zagulyaky_public_indexing on commit drop as
select
  public.list_public_zagulyaky_indexing_v1('person', 1, null) as first_person_page,
  public.list_public_zagulyaky_indexing_v1('person', 1, 'seo-index-person-a') as second_person_page,
  public.list_public_zagulyaky_indexing_v1('person', 100, null) as all_people,
  public.list_public_zagulyaky_indexing_v1('document', 100, null) as documents;

select is(
  jsonb_array_length((select first_person_page -> 'items' from pgtap_zagulyaky_public_indexing)),
  1,
  'the public indexing list honors a bounded page size'
);
select is(
  (select first_person_page ->> 'nextCursor' from pgtap_zagulyaky_public_indexing),
  'seo-index-person-a',
  'the first page returns a public-slug cursor only'
);
select is(
  (select second_person_page -> 'items' -> 0 ->> 'slug' from pgtap_zagulyaky_public_indexing),
  'seo-index-person-b',
  'the public slug cursor advances deterministically without a UUID'
);
select is(
  jsonb_array_length((select all_people -> 'items' from pgtap_zagulyaky_public_indexing)),
  2,
  'draft, blocked, and uncleared possible-living records are absent before pagination'
);
select is(
  (select all_people -> 'items' -> 0 ->> 'originalText' from pgtap_zagulyaky_public_indexing),
  'Оригінальний текст Анни',
  'the SEO row contains the public original transcription'
);
select is(
  (select all_people -> 'items' -> 0 ->> 'normalizedText' from pgtap_zagulyaky_public_indexing),
  'Нормалізований текст Анни',
  'the SEO row contains the public normalized transcription'
);
select is(
  (select all_people -> 'items' -> 0 -> 'subject' ->> 'normalizedUkFullName' from pgtap_zagulyaky_public_indexing),
  'Анна Індексова',
  'the SEO row includes only the first public subject name'
);
select is(
  (select all_people -> 'items' -> 0 -> 'primarySource' ->> 'citation' from pgtap_zagulyaky_public_indexing),
  'ф. 127, оп. 1012, спр. 305',
  'the SEO row includes the primary source citation'
);
select ok(
  not ((select all_people -> 'items' -> 0 from pgtap_zagulyaky_public_indexing)
    ?| array['id', 'publishedAt', 'createdBy', 'contributor', 'payload', 'publicAttachments'])
  and not ((select all_people -> 'items' -> 0 -> 'subject' from pgtap_zagulyaky_public_indexing) ? 'id')
  and not ((select all_people -> 'items' -> 0 -> 'primarySource' from pgtap_zagulyaky_public_indexing) ? 'sourceUrl')
  and position('d7000000-0000-4000-8000-000000000001' in (select all_people::text from pgtap_zagulyaky_public_indexing)) = 0
  and position('private.example.test' in (select all_people::text from pgtap_zagulyaky_public_indexing)) = 0
  and position('ПРИВАТНА НОТАТКА УЧАСНИКА' in (select all_people::text from pgtap_zagulyaky_public_indexing)) = 0,
  'the people indexing response has no IDs, source URL, or private participant data'
);
select is(
  (select documents -> 'items' -> 0 -> 'documentDiscovery' ->> 'officialLocationText' from pgtap_zagulyaky_public_indexing),
  'Офіційний опис',
  'the document indexing row includes a public structured discovery'
);
select ok(
  not ((select documents -> 'items' -> 0 -> 'documentDiscovery' from pgtap_zagulyaky_public_indexing) ? 'notes')
  and position('ПРИВАТНА НОТАТКА ПРО ДОКУМЕНТ' in (select documents::text from pgtap_zagulyaky_public_indexing)) = 0,
  'the document indexing response excludes discovery notes'
);
select throws_ok(
  $$select public.list_public_zagulyaky_indexing_v1('unsupported', 100, null)$$,
  '22023',
  'INVALID_ZAGULYAKY_KIND',
  'the indexing RPC rejects an unsupported catalogue kind'
);
select throws_ok(
  $$select public.list_public_zagulyaky_indexing_v1('person', 100, 'x')$$,
  '22023',
  'INVALID_ZAGULYAKY_INDEXING_CURSOR',
  'the indexing RPC rejects a malformed public cursor'
);

select * from finish();
rollback;
