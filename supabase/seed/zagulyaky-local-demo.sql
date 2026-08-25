-- LOCAL-ONLY demo data for manual catalogue testing.
--
-- Do not point this file at a linked or hosted Supabase project. It uses fixed
-- demo IDs and example.test URLs, is idempotent, and creates no Storage files.
-- Apply only after migrations 202608180002 and 202608180003 have run locally.

begin;

insert into public.zagulyaky_records (
  id, kind, status, verification_status, privacy_status, public_slug,
  title, summary, original_text, normalized_text, original_language,
  event_type, event_date_text, event_year_from, event_year_to, date_precision,
  source_location_text, source_location_normalized,
  found_location_text, found_location_normalized, classification_reason,
  payload, possible_living_person, published_at, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000001', 'person', 'published', 'corroborated', 'cleared',
    'demo-mariia-testova-1891',
    'Демо: Марія Тестова (1891)',
    'Тестова картка історичної особи, знайденої у нетиповому для пошуку документі.',
    'Марія Тестова згадана у локальному тестовому витязі.',
    'Марія Тестова згадана у локальному тестовому витязі.', 'uk',
    'birth', '1891 рік', 1891, 1891, 'year',
    'с. Демівка', 'с. Демівка',
    'Каталог локального демо', 'Каталог локального демо',
    'Згадку знайдено поза очікуваним описом фонду; це лише тестові дані.',
    '{"demo":true,"source":"local-seed"}'::jsonb, false,
    '2026-08-18T12:00:00Z'::timestamptz, '2026-08-18T12:00:00Z'::timestamptz, '2026-08-18T12:00:00Z'::timestamptz
  ),
  (
    '10000000-0000-4000-8000-000000000002', 'document', 'published', 'verified', 'cleared',
    'demo-metrychnyi-vytiah-1891',
    'Демо: метричний витяг за 1891 рік',
    'Тестова документна знахідка для перевірки вкладки «Документи» та фільтрів.',
    'Метричний витяг: локальний демонстраційний запис.',
    'Метричний витяг: локальний демонстраційний запис.', 'uk',
    'baptism', '1891 рік', 1891, 1891, 'year',
    'Демо-архів', 'Демо-архів',
    'Локальна тестова добірка', 'Локальна тестова добірка',
    'Документ знайдено у демонстраційній вибірці поза штатним каталогом.',
    '{"demo":true,"source":"local-seed"}'::jsonb, false,
    '2026-08-18T12:01:00Z'::timestamptz, '2026-08-18T12:01:00Z'::timestamptz, '2026-08-18T12:01:00Z'::timestamptz
  )
on conflict (id) do update set
  kind = excluded.kind,
  status = excluded.status,
  verification_status = excluded.verification_status,
  privacy_status = excluded.privacy_status,
  public_slug = excluded.public_slug,
  title = excluded.title,
  summary = excluded.summary,
  original_text = excluded.original_text,
  normalized_text = excluded.normalized_text,
  original_language = excluded.original_language,
  event_type = excluded.event_type,
  event_date_text = excluded.event_date_text,
  event_year_from = excluded.event_year_from,
  event_year_to = excluded.event_year_to,
  date_precision = excluded.date_precision,
  source_location_text = excluded.source_location_text,
  source_location_normalized = excluded.source_location_normalized,
  found_location_text = excluded.found_location_text,
  found_location_normalized = excluded.found_location_normalized,
  classification_reason = excluded.classification_reason,
  payload = excluded.payload,
  possible_living_person = false,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at;

insert into public.zagulyaky_sources (
  id, source_type, title, archive_name, fond, inventory, file_number,
  page_from, citation, source_url, source_platform, external_id,
  permission_status, metadata, created_at, updated_at
) values
  (
    '10000000-0000-4000-8000-000000000011', 'archive',
    'Демо: локальний архівний витяг', 'Демо-архів', 'Ф. 1', 'Оп. 1', 'Спр. 1', 'Арк. 1',
    'Локальний тестовий витяг; не історичне джерело.',
    'https://example.test/zagulyaky-demo/person-source', 'local_demo', 'person-source-001',
    'public_domain', '{"demo":true}'::jsonb, '2026-08-18T12:00:00Z'::timestamptz, '2026-08-18T12:00:00Z'::timestamptz
  ),
  (
    '10000000-0000-4000-8000-000000000012', 'archive',
    'Демо: метрична книга', 'Демо-архів', 'Ф. 2', 'Оп. 3', 'Спр. 8', 'Арк. 42',
    'Локальний тестовий документ; не історичне джерело.',
    'https://example.test/zagulyaky-demo/document-source', 'local_demo', 'document-source-001',
    'public_domain', '{"demo":true}'::jsonb, '2026-08-18T12:01:00Z'::timestamptz, '2026-08-18T12:01:00Z'::timestamptz
  )
on conflict (id) do update set
  source_type = excluded.source_type,
  title = excluded.title,
  archive_name = excluded.archive_name,
  fond = excluded.fond,
  inventory = excluded.inventory,
  file_number = excluded.file_number,
  page_from = excluded.page_from,
  citation = excluded.citation,
  source_url = excluded.source_url,
  source_platform = excluded.source_platform,
  external_id = excluded.external_id,
  permission_status = excluded.permission_status,
  metadata = excluded.metadata,
  updated_at = excluded.updated_at;

insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', true),
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000012', true)
on conflict (record_id, source_id) do update set is_primary = excluded.is_primary;

insert into public.zagulyaky_participants(
  id, record_id, role, original_full_name, normalized_uk_full_name,
  surname, given_name, sex, notes, sort_order
)
select
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000001',
  'subject', 'Марія Тестова', 'Марія Тестова', 'Тестова', 'Марія', 'female',
  'Вигадана особа для локальної перевірки каталогу.', 0
where not exists (
  select 1 from public.zagulyaky_participants
  where id = '10000000-0000-4000-8000-000000000021'
);

insert into public.zagulyaky_document_discoveries(
  id, record_id, official_location_text, discovered_location_text,
  record_types, factual_year_from, factual_year_to, page_from, notes
)
select
  '10000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000002',
  'Демо-архів, фонд 2, опис 3, справа 8', 'Локальна тестова добірка',
  array['метрична книга']::text[], 1891, 1891, '42',
  'Вигаданий документ для локальної перевірки каталогу.'
where not exists (
  select 1 from public.zagulyaky_document_discoveries
  where id = '10000000-0000-4000-8000-000000000022'
);

commit;
