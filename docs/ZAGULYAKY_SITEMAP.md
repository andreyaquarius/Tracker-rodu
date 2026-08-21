# Sitemap публічного каталогу «Загуляки»

`public/sitemap.xml` містить лише стабільні публічні URL каталогу:

- `https://trekerrodu.com.ua/zahuliaky`;
- `https://trekerrodu.com.ua/zahuliaky/documents`.

Особистий розділ `/zahuliaky/my`, адмін-маршрути, чернетки, записи на модерації та відхилені записи до sitemap не потрапляють. У `public/robots.txt` окремо оголошено динамічний sitemap `https://trekerrodu.com.ua/sitemap-zagulyaky.xml` для деталок уже опублікованих записів.

## Що генерується і чому це безпечно

`scripts/generate-zagulyaky-sitemap.mjs` викликає тільки два публічні RPC:

- `search_zagulyaky_people_v1`;
- `search_zagulyaky_documents_v1`.

Ці RPC за foundation-міграцією повертають лише `published` записи з `privacy_status = cleared`. Генератор читає з кожного рядка **лише `slug`** та створює канонічний URL. Він не звертається до таблиць напряму, не використовує `service_role`/`secret` key, не друкує ключі й не записує до XML назву, автора, джерело, ідентифікатор запису чи будь-яке приватне поле.

Для роботи дозволено тільки:

- `ZAGULYAKY_SITEMAP_SUPABASE_URL` або наявний `VITE_SUPABASE_URL`;
- `ZAGULYAKY_SITEMAP_PUBLISHABLE_KEY` або наявний `VITE_SUPABASE_PUBLISHABLE_KEY`.

Скрипт відмовляється працювати з `sb_secret_`, з JWT не-`anon` ролі та з будь-яким іншим непізнаним типом ключа. Значення цих змінних не додаються до Git, sitemap або логу.

## Передумови

1. Foundation-міграцію «Загуляк» застосовано до цільової Supabase-БД.
2. Анонімний виклик обох публічних search RPC успішний.
3. У БД є лише записи, які дозволено показувати публічно: `published` і `cleared`.

Якщо міграція ще не застосована або RPC повертає помилку, генератор завершується з помилкою і не створює частковий sitemap.

## Локальна перевірка

Статичний каталог доступний із Vite одразу:

```text
http://localhost:5173/sitemap.xml
```

Він має містити два URL каталогу та не має містити `/zahuliaky/my`.

Щоб згенерувати динамічний файл для production-build, використайте локальний `.env.local` без виведення його в консоль:

```powershell
npm.cmd run build
node --env-file=.env.local .\scripts\generate-zagulyaky-sitemap.mjs
npm.cmd run verify:pages
```

Файл буде створено у `dist/sitemap-zagulyaky.xml`. Його можна переглянути після запуску preview-сервера. Для короткої перевірки саме через Vite dev server дозволено явно вказати output у `public`:

```powershell
node --env-file=.env.local .\scripts\generate-zagulyaky-sitemap.mjs --output .\public\sitemap-zagulyaky.xml
```

Після цього відкрийте:

```text
http://localhost:5173/sitemap-zagulyaky.xml
```

Це локальний generated artifact: не додавайте його до коміту. Після перевірки приберіть лише цей файл, якщо він більше не потрібен:

```powershell
Remove-Item -LiteralPath .\public\sitemap-zagulyaky.xml
```

## Перед production-деплоєм

Поточний workflow навмисно не змінювався цією задачею. Власник релізу має додати крок **після отримання VITE Supabase public values і перед upload `dist`**:

```yaml
- name: Generate public Zagulyaky sitemap
  env:
    VITE_SUPABASE_URL: ${{ secrets.VITE_SUPABASE_URL }}
    VITE_SUPABASE_PUBLISHABLE_KEY: ${{ secrets.VITE_SUPABASE_PUBLISHABLE_KEY }}
  run: node scripts/generate-zagulyaky-sitemap.mjs
```

Якщо генерація виконується після `npm run build`, вона записує файл безпосередньо в `dist`, тому повторний build після неї не потрібен. Не підставляйте `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` або інший серверний секрет: вони не потрібні для цього завдання й будуть відхилені генератором.

Після першого production-деплою перевірте обидва sitemap у Search Console. Кореневий sitemap уже оголошений у `robots.txt`; dynamic sitemap також оголошений там окремим рядком.
