# «Загуляки» — Stage 0: політика, довідники та локальна перевірка

Статус: локальна реалізація Stage 0. Цей документ описує лише приватний
staging-імпорт Facebook JSON. Він не дозволяє автоматично створювати,
публікувати, зливати або змінювати записи каталогу.

## 1. Затверджене робоче визначення

**Загуляка** — це історична особа, документна згадка або обґрунтований факт,
який знайдено поза очікуваним місцем пошуку (іншим фондом, описом, населеним
пунктом, типом джерела, мовним або родинним контекстом), але який може бути
перевірений через джерело та редакційний розгляд.

Не є «загулякою» лише тому, що матеріал є цікавим:

- неперевірений переказ без джерела;
- автоматичний OCR/AI-висновок без людської перевірки;
- Facebook-профіль або коментар без історичного змісту;
- сучасні персональні дані чи фотографія людини, яка може бути живою;
- повтор тієї самої особи, який не має окремого джерельного або фактологічного
  значення.

Один social-post може дати `0..N` майбутніх записів людей або документів.
Автоматичне злиття історичних осіб заборонено.

## 2. Правила можливих живих осіб

1. `possible_living_person` є блокувальним quarantine-прапорцем, а не
   доказом, що особа жива або померла.
2. Імпортер **ніколи не вгадує** цей прапорець за ім’ям, текстом, датою чи
   зображенням. Такі евристики занадто ризиковані; рішення фіксує модератор.
3. Матеріал із прапорцем не можна витягати зі staging у публічний запис,
   допоки не виконано окрему перевірку приватності, прав та джерела.
4. Для запису з прапорцем консервативним робочим правилом є лише
   **документована згода**: дата її отримання, відповідальний модератор і
   приватне посилання або номер доказу. Якщо є підтвердження смерті чи інша
   законна підстава, модератор спершу виправляє сам прапорець і фіксує причину
   в журналі модерації, а не обходить правило живої особи.

### Технічне enforcement-правило

Міграція `202608190001_zagulyaky_privacy_and_attachment_delivery.sql` додає
приватний реєстр `zagulyaky_privacy_clearances` і `BEFORE INSERT OR UPDATE`
тригер. Тому запис із `possible_living_person = true` не може стати
`privacy_status = 'cleared'` або `published`, доки модератор не зафіксує
схвалену документовану згоду. Попередньо очищені записи з таким прапорцем
автоматично повертаються в `requires_consent`; вони зникають з публічної
проєкції без розкриття доказу згоди.

## 3. Авторство, текст і вкладення

- `source_author_label` — приватна provenance-інформація з Facebook; вона
  ніколи не стає публічною атрибуцією автоматично.
- Публічний автор запису Трекера, автор Facebook-допису та автор історичного
  документа — різні ролі. Кожну потрібно підтвердити окремо.
- Сирий текст і `raw_payload` залишаються в staging, не індексуються
  публічним API й не потрапляють у журнали Edge Function.
- CDN URL Facebook є тимчасовим і приватним metadata. Імпортер не переходить
  за ним, не завантажує файл і не створює public Storage object.
- Публічна похідна копія зображення можлива лише після окремого rights review:
  `pending_review` → `approved_for_derivative`; для `rejected` або `revoked`
  публічна копія не створюється.
- Вкладення, додане автором вручну, спершу зберігається тільки в
  `zagulyaky-private`. Модератор отримує короткочасне підписане посилання для
  перегляду; контрольована публічна копія створюється сервером лише для вже
  опублікованого запису з `privacy_status = 'cleared'`. Public bucket також
  не є відкритим: сторінка деталі отримує короткочасне посилання тільки після
  повторної перевірки публічного статусу запису.
- За відсутності права на повне відтворення допустимі лише структурований факт,
  коротка дозволена цитата та посилання на джерело.

## 4. Довідники Stage 0

| Поле | Допустимі значення | Значення |
|---|---|---|
| `import_mode` | `dry_run`, `commit` | Спершу обов’язковий dry run; commit того самого SHA-256 можливий лише після dry run без помилок контракту. |
| `batch.status` | `received`, `processing`, `dry_run_complete`, `completed`, `completed_with_errors`, `failed`, `cancelled` | Технічний стан приватного пакета. |
| `source_date_precision` | `exact`, `parsed_from_text`, `inferred_current_year`, `relative_unresolved`, `unknown` | Точність дати Facebook-допису, а не історичної події. Поточний імпортер ставить лише `exact` або `unknown`. |
| `stage_status` | `staged`, `quarantined`, `structured`, `linked`, `ignored` | Внутрішня готовність матеріалу, не публічний статус доказовості. |
| `download_status` | `not_requested`, `queued`, `downloaded`, `failed`, `skipped` | Стан майбутньої приватної доставки вкладення. |
| `rights_status` | `unknown`, `pending_review`, `approved_for_derivative`, `rejected`, `revoked` | Право на похідну копію; `approved_for_derivative` не означає права на текст допису. |
| `job_type` | `ocr`, `structure`, `source_refetch`, `duplicate_check` | Черги створюють лише чернетки/сигнали; вони не публікують матеріал. |

Обов’язкові прапорці staging-елемента: `source_incomplete`,
`text_truncated`, `requires_ocr`, `requires_source_refetch`, `missing_author`,
`missing_publication_date`, `suspected_duplicate`, `rights_review_required`,
`possible_living_person`, `quarantined`.

Довідники публічного каталогу залишаються такими, як у foundation:

- вид: `person`, `document`;
- workflow: `draft`, `pending_review`, `needs_changes`, `published`, `rejected`,
  `withdrawn`, `merged`, `archived`;
- доказовість: `unverified`, `plausible`, `corroborated`, `verified`, `disputed`;
- приватність: `pending`, `cleared`, `blocked`, `requires_consent`.

## 5. Межі доступу та контракт імпорту

Міграція `202608180003_zagulyaky_staging_import.sql` додає:

- пакети, canonical staging-елементи та many-to-many `batch_items`;
- private attachment assets, appearances, links, extraction jobs, item errors
  та аудит без raw content;
- зв’язок `zagulyaky_ingestion_item_records` для майбутньої ручної роботи;
- RLS увімкнено на **кожній** staging-таблиці;
- `anon` і `authenticated` не мають прямих табличних привілеїв;
- лише `service_role` може записувати chunks або фіналізувати пакет;
- лише адміністратор із `zagulyaky.import` може створити або прочитати
  sanitized metadata пакета через RPC.

Навіть цей admin RPC не зберігає довільний `profile_summary`: БД відкидає
не-об’єктні/завеликі значення та записує лише allowlisted числові лічильники.
Тому raw текст не можна передати до зворотної batch-відповіді через поле
агрегованої статистики.

Edge Function `zagulyaky-stage0-import` приймає raw JSON export у тілі `POST`:

```text
Content-Type: application/json
Authorization: Bearer <JWT адміністратора з zagulyaky.import>
x-zagulyaky-import-mode: dry_run | commit
x-zagulyaky-source-file-name: <лише ім’я .json файла>
x-zagulyaky-source-checksum: <SHA-256 точних байтів body>
```

Вона обмежує body до 20 MiB та 5 000 дописів, обчислює SHA-256 точних байтів,
порівнює його з заголовком, перевіряє JWT, викликає caller-authorized RPC, а
потім використовує service key тільки для chunked staging RPC. Один chunk має
до 250 елементів; receipt + checksum захищають від дублювання при retry.

Ніяких URL із export не відкриваються під час імпорту. У логах не фіксуються
допис, автор, URL, payload або access token.

## 6. Локальна перевірка каталогу на `http://localhost:5173/`

Нижче наведені команди стосуються **лише локального** Supabase. Не додавайте
`--linked`, не вказуйте remote `--db-url` і не запускайте їх проти production.

1. За потреби запустіть локальний Supabase:

   ```powershell
   npm.cmd exec -- supabase start
   ```

2. Застосуйте всі локальні міграції та local-only demo seed однією командою:

   ```powershell
   npm.cmd exec -- supabase db reset --local --sql-paths seed/zagulyaky-local-demo.sql
   ```

   **Увага:** `db reset --local` видаляє й заново створює вашу локальну БД.
   Він не виконує віддалених дій, якщо не додавати `--linked`, але локальні
   дані буде втрачено.

3. Якщо локальна БД уже має потрібні міграції й скидати її не треба, застосуйте
   лише idempotent demo seed:

   ```powershell
   npm.cmd exec -- supabase db query --local --file .\supabase\seed\zagulyaky-local-demo.sql
   ```

4. Запустіть frontend:

   ```powershell
   npm.cmd run dev
   ```

   Потім відкрийте:

   - `http://localhost:5173/zahuliaky` — демо-особа;
   - `http://localhost:5173/zahuliaky/documents` — демо-документ;
   - `http://localhost:5173/zahuliaky/people/demo-mariia-testova-1891`;
   - `http://localhost:5173/zahuliaky/documents/demo-metrychnyi-vytiah-1891`.

Seed використовує лише вигадані назви, fixed UUID і `example.test`; він не
створює Storage-файлів, не містить Facebook-експорту й не торкається remote.

## 7. Перед production

Перед будь-яким production deployment потрібно окремо підтвердити:

1. DB/RLS тести для `anon`, звичайного користувача, адміністратора без
   дозволу, адміністратора з `zagulyaky.import` і service worker;
2. dry run справжнього export без витоку raw даних у логи;
3. ручну вибірку повних, обрізаних, image-only і quarantined дописів;
4. workflow завантаження файлів у приватний bucket, MIME/розмір/SHA-256,
   rights review і видалення Storage-об’єктів;
5. сценарій документованої згоди для можливих живих осіб: спроба publish без
   неї має бути відхилена, а після зафіксованої згоди — дозволена;
6. ручний duplicate-review і merge workflow — ніколи не автоматичний merge.
