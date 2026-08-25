# Публічні HTML-сторінки та sitemap каталогу «Загуляки»

Публічний каталог «Загуляки» має два sitemap:

- `https://trekerrodu.com.ua/sitemap.xml` — стабільні сторінки каталогу:
  - `https://trekerrodu.com.ua/zahuliaky`;
  - `https://trekerrodu.com.ua/zahuliaky/documents`.
- `https://trekerrodu.com.ua/sitemap-zagulyaky.xml` — канонічні URL усіх
  опублікованих публічних карток людей і документів.

Обидва sitemap оголошено в `public/robots.txt`. Особистий розділ
`/zahuliaky/my`, адмін-маршрути, чернетки, записи на модерації та відхилені
записи до них не потрапляють.

## Що створюється під час деплою

Після `npm run build` workflow запускає
`scripts/generate-zagulyaky-public-pages.mjs`. Скрипт створює у `dist`:

```text
dist/zahuliaky/index.html
dist/zahuliaky/documents/index.html
dist/zahuliaky/people/<slug>/index.html
dist/zahuliaky/documents/<slug>/index.html
dist/sitemap-zagulyaky.xml
```

Це не дублікати даних у репозиторії, а статичні HTML-проєкції, які GitHub
Pages може віддати за прямим URL ще до виконання JavaScript. Кожна картка має:

- видимий заголовок та короткий опис для людини й пошукового робота;
- canonical URL, `robots: index, follow`, Open Graph і Twitter metadata;
- JSON-LD `ProfilePage`/`Person` для людини або `CreativeWork` для документа;
- JSON-LD breadcrumbs.

Так Google отримує окремий доступний URL для каталогу та для кожної публічної
картки, а не лише SPA-сторінку, яку GitHub Pages інакше віддав би через
`404.html`.

## Дані, які дозволено виводити

За нормального стану генератор викликає лише один анонімний публічний RPC,
пагінований за типом картки:

- `list_public_zagulyaky_indexing_v1`.

Він створюється міграцією `202608250007_zagulyaky_public_seo_indexing.sql` і
повертає вже очищений для індексації набір даних. Це принципово відрізняється
від тисяч окремих викликів detail endpoint, які можуть перевищити timeout.
Якщо міграцію ще не застосовано або PostgREST ще не оновив schema cache,
генератор безпечно переходить на наявні `search_zagulyaky_people_v1` і
`search_zagulyaky_documents_v1`: сторінки та sitemap все одно з'являться, але
без повного тексту транскрипції до наступного деплою після міграції.

RPC повертає лише записи зі статусом `published` і
`privacy_status = cleared`, а також відсіює можливих живих осіб без чинного
дозволу. Із відповідей до статичного HTML потрапляють тільки
поля, призначені для публічного каталогу: назва/ПІБ, короткий опис, тип і дата
події, публічні назви місць, бібліографічне посилання на джерело та
транскрипція `originalText`/`normalizedText`, яку повернув саме публічний
detail RPC. Це робить інформацію з картки доступною пошуку за ПІБ, місцем,
датою й текстом запису.

Генератор навмисно не додає до HTML або sitemap:

- ідентифікатори записів, автора чи дані приватних сесій;
- приватний payload, сирий імпортований допис, чернетки ШІ/OCR або нотатки
  учасників (навіть якщо вони є у внутрішньому записі);
- URL приватних джерел, тимчасові Facebook CDN URL, storage-path або дані
  вкладень;
- записи, що не були опубліковані або не пройшли перевірку приватності.

Для запуску достатньо browser-safe змінних `VITE_SUPABASE_URL` і
`VITE_SUPABASE_PUBLISHABLE_KEY`. Не використовуйте
`SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` або інші серверні секрети:
вони не потрібні та відхиляються перевіркою генератора.

## Локальна перевірка

Після локального build виконайте генератор із `.env.local`, де є тільки
публічні Supabase credentials:

```powershell
npm.cmd run build
node --env-file=.env.local .\scripts\generate-zagulyaky-public-pages.mjs
npm.cmd run verify:pages
```

Перевірте щонайменше:

```text
dist/sitemap.xml
dist/sitemap-zagulyaky.xml
dist/zahuliaky/index.html
dist/zahuliaky/documents/index.html
```

Згенеровані файли в `dist` — build artifacts. Не додавайте їх до Git і не
редагуйте вручну.

## Критичне правило оновлення

Статична картка відображає стан каталогу на момент останнього деплою. Тому
потрібен новий deployment у `main` після кожної зміни, яка впливає на
публічність або зміст картки:

- опублікування чи зняття з публікації;
- зміна `privacy_status`;
- зміна slug, назви, ПІБ, короткого опису, події, місця або джерела;
- об'єднання, видалення або приховування публічного запису.

Без нового деплою Google і відвідувачі можуть тимчасово бачити застарілу
статичну версію, навіть якщо Supabase уже містить новий стан. Звичайний
production workflow генерує сторінки та sitemap автоматично — вручну копіювати
файли з `dist` не потрібно.

## Після production-деплою

1. Переконайтеся, що відкриваються обидва sitemap:

   ```text
   https://trekerrodu.com.ua/sitemap.xml
   https://trekerrodu.com.ua/sitemap-zagulyaky.xml
   ```

2. У Google Search Console додайте або оновіть обидва sitemap.
3. Через URL Inspection перевірте каталог і щонайменше одну картку людини та
   одну картку документа. Для перевірки використовуйте саме канонічні URL.
4. Переконайтеся, що URL не має `noindex`, не веде на `404.html`, а canonical
   збігається з URL картки.

Sitemap допомагає Google знайти сторінки, але не гарантує індексацію кожної з
них і не є гарантією появи інформації у відповідях будь-яких ШІ-сервісів.
Відстежуйте фактичний стан у Search Console.
