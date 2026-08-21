# «Загуляки» — локальне тестування Stage 0–2

Це відтворюваний сценарій для Windows PowerShell, який перевіряє:

| Етап | Що перевіряється |
| --- | --- |
| Stage 0 | приватний Facebook JSON staging: dry run, commit, checksum, роль імпортера та відсутність автоматичної публікації |
| Stage 1 | публічні каталоги людей і документів, пошук, картки, canonical URL, robots та sitemap |
| Stage 2 | авторські чернетки, подання, повернення на уточнення, модерація, версії, аудит, звернення та кандидати на дублікати |

Усі команди нижче призначені **лише для локального** стеку Supabase і
frontend на `http://localhost:5173`. Не виконуйте їх проти linked, staging або
production-проєкту.

## 0. Незмінні межі безпеки

Працюйте з кореня репозиторію:

```powershell
Set-Location 'D:\Development\Project\Родовий Навігатор'
```

У цьому сценарії заборонено використовувати будь-яку з таких команд або
параметрів:

- `supabase link`;
- `supabase db push`;
- `supabase functions deploy`;
- `--linked`, `--db-url` або URL віддаленої БД;
- `VITE_SUPABASE_URL=https://...`;
- `VITE_SUPABASE_SECRET_KEY`, `VITE_SUPABASE_SERVICE_ROLE_KEY` або інший
  server/secret key у браузерному `.env.local`.

Усі SQL-команди в документі мають явний прапорець `--local`. Не прибирайте
його. Локальний `project_id` у `supabase/config.toml` сам по собі не означає,
що команда торкається хмарного проєкту.

`db reset --local` є руйнівною операцією для **локальної** БД: вона видаляє її
вміст і створює заново з локальних міграцій. Перед запуском збережіть будь-які
локальні дані, які не можна втратити. Команда нижче не має працювати з
віддаленими даними, доки збережено `--local` і не додано `--linked`/`--db-url`.

## 1. Передумови: Docker та локальний Supabase

1. Відкрийте Docker Desktop і дочекайтеся, поки Linux container engine стане
   доступним.
2. У першому PowerShell-вікні перевірте, що Docker має відповідь саме від
   сервера, а не лише від клієнта:

   ```powershell
   docker version
   ```

   У виводі має бути секція `Server`. Якщо є помилка на зразок
   `dockerDesktopLinuxEngine`, спершу запустіть Docker Desktop; не змінюйте
   міграції або frontend для обходу цієї проблеми.

3. Запустіть локальний стек:

   ```powershell
   npm.cmd exec -- supabase start
   npm.cmd exec -- supabase status --output env
   ```

   На чистій машині перший `start` може завантажити Docker images. Типові
   локальні адреси: API `http://127.0.0.1:54321`, Studio
   `http://127.0.0.1:54323`, Mailpit `http://127.0.0.1:54324`.

Не вставляйте повний вивід `status --output env` у чат, issue або commit: він
містить локальні серверні ключі. Для frontend потрібен тільки publishable/anon
key, а Edge Runtime одержує серверний ключ локально без передачі його в
браузер.

## 2. Міграції та безпечний демо-seed

### Чистий локальний запуск

Виконайте рівно цю команду, коли можна стерти локальну БД:

```powershell
npm.cmd exec -- supabase db reset --local --sql-paths seed/zagulyaky-local-demo.sql
```

`--sql-paths` задає шлях від каталогу `supabase`, тому тут навмисно використано
`seed/zagulyaky-local-demo.sql`, а не шлях від кореня репозиторію. Команда
послідовно застосує всі локальні міграції, включно зі Stage 0–2, а потім
додасть тільки вигадані local-only дані.

Seed створює:

- публічну очищену особу `Демо: Марія Тестова (1891)`;
- публічний очищений документ `Демо: метричний витяг за 1891 рік`;
- тільки fixed UUID, `example.test` та вигадані джерела;
- одну приватну демонстраційну staging-лінію без реального Facebook export,
  вкладення або Storage-файлу.

### Додати лише демо-дані без reset

Якщо локальні міграції вже застосовані та дані потрібно зберегти, виконайте
тільки idempotent seed:

```powershell
npm.cmd exec -- supabase db query --local --file .\supabase\seed\zagulyaky-local-demo.sql
```

Не використовуйте цей файл як production seed і не передавайте його через
`--linked`.

## 3. Налаштувати Vite тільки на локальний Supabase

Нижче PowerShell отримує **лише** API URL і publishable/anon key з локального
`supabase status`, перевіряє loopback-host та оновлює в `.env.local` тільки
три пов'язані Vite-змінні. Решта вже наявних рядків `.env.local` зберігається,
а резервна копія потрапляє в `%TEMP%`, не в репозиторій.

```powershell
$localStatus = npm.cmd exec -- supabase status --output env

function Get-LocalSupabaseStatusValue([string]$name) {
  $prefix = "$name="
  $line = @($localStatus | Where-Object { $_.StartsWith($prefix) })[0]
  if ([string]::IsNullOrWhiteSpace($line)) { return $null }
  return $line.Substring($prefix.Length).Trim().Trim('"')
}

$localSupabaseUrl = Get-LocalSupabaseStatusValue 'API_URL'
if ([string]::IsNullOrWhiteSpace($localSupabaseUrl)) {
  $localSupabaseUrl = Get-LocalSupabaseStatusValue 'SUPABASE_URL'
}
$localPublishableKey = Get-LocalSupabaseStatusValue 'PUBLISHABLE_KEY'
if ([string]::IsNullOrWhiteSpace($localPublishableKey)) {
  # Older local CLI output calls the browser-safe key ANON_KEY.
  $localPublishableKey = Get-LocalSupabaseStatusValue 'ANON_KEY'
}
if ([string]::IsNullOrWhiteSpace($localSupabaseUrl) -or [string]::IsNullOrWhiteSpace($localPublishableKey)) {
  throw 'Не вдалося знайти локальні API_URL і PUBLISHABLE_KEY/ANON_KEY у supabase status.'
}

$uri = [Uri]$localSupabaseUrl
if ($uri.Host -notin @('localhost', '127.0.0.1', '::1')) {
  throw "Відмова: Supabase URL не loopback: $localSupabaseUrl"
}

$envPath = Join-Path $PWD '.env.local'
$backupDirectory = Join-Path $env:TEMP 'tracker-rodu-env-backups'
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
if (Test-Path -LiteralPath $envPath) {
  $backupPath = Join-Path $backupDirectory (".env.local.before-zagulyaky-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item -LiteralPath $envPath -Destination $backupPath
  Write-Host "Резервну копію .env.local збережено в $backupPath"
}

$existingLines = if (Test-Path -LiteralPath $envPath) { @(Get-Content -LiteralPath $envPath) } else { @() }
$unsafeBrowserKey = $existingLines | Where-Object { $_ -match '^\s*VITE_.*(?:SECRET|SERVICE)\s*=' } | Select-Object -First 1
if ($unsafeBrowserKey) {
  throw 'У .env.local знайдено VITE_-secret/service key. Приберіть його вручну: серверні ключі ніколи не належать браузеру.'
}

$keptLines = @($existingLines | Where-Object {
  $_ -notmatch '^\s*VITE_(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY|LOCAL_EDGE_FUNCTIONS_URL)\s*='
})
$localViteLines = @(
  "VITE_SUPABASE_URL=$localSupabaseUrl",
  "VITE_SUPABASE_PUBLISHABLE_KEY=$localPublishableKey",
  "VITE_LOCAL_EDGE_FUNCTIONS_URL=$localSupabaseUrl/functions/v1"
)
@($keptLines + $localViteLines) | Set-Content -LiteralPath $envPath -Encoding utf8
```

Після цього відкрийте **друге** PowerShell-вікно і запустіть Vite на точно
заданому loopback-порту:

```powershell
Set-Location 'D:\Development\Project\Родовий Навігатор'
npm.cmd run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

`--strictPort` важливий: якщо `5173` зайнятий, Vite завершиться з помилкою,
замість тихо перейти на `5174` і зробити перевірку не того URL. Відкрийте
`http://localhost:5173/`.

### 3.1. Локальні Edge Functions для Stage 0 і Stage 2

В **окремому** PowerShell-вікні (після `supabase start`) залиште запущеним
локальний Edge Runtime:

```powershell
Set-Location 'D:\Development\Project\Родовий Навігатор'
npm.cmd exec -- supabase functions serve
```

Поточна pinned-версія CLI запускає всі функції з `supabase/functions/` одним
процесом. Це, зокрема, дає локальні endpoint-и для:

- `zagulyaky-stage0-import` — контрольованого імпорту Facebook export;
- `zagulyaka-attachment` — приватного перегляду та короткочасної публічної
  доставки вкладень;
- `zagulyaky-storage-cleanup` — безпечного очищення видалених приватних і
  відкликаних публічних копій.

`VITE_LOCAL_EDGE_FUNCTIONS_URL` з кроку 3 уже вказує на
`$localSupabaseUrl/functions/v1`, тому окремо копіювати service key, складати
URL або відкривати доступ браузеру до Storage не потрібно. Не закривайте це
вікно до завершення перевірок вкладень та імпорту.

## 4. Публічний smoke test Stage 1

Проводьте цю частину у приватному вікні браузера, ще до входу тестового автора.

1. Відкрийте `http://localhost:5173/zahuliaky`.
   - Є картка `Демо: Марія Тестова (1891)`.
   - Пошук за `Марія` або `Тестова` знаходить демо-запис.
   - Відкривається картка
     `/zahuliaky/people/demo-mariia-testova-1891`.
2. Відкрийте `http://localhost:5173/zahuliaky/documents`.
   - Є `Демо: метричний витяг за 1891 рік`.
   - Фільтр/пошук за `1891` або `метричний` працює.
   - Відкривається картка
     `/zahuliaky/documents/demo-metrychnyi-vytiah-1891`.
3. Переконайтеся, що на публічних маршрутах немає кнопок чи даних приватних
   чернеток, авторських сесій та staging payload.
4. Відкрийте `http://localhost:5173/zahuliaky/my` без входу. Очікуваний
   результат — запит увійти; список чернеток не розкривається.

## 5. Створити локального тестового автора й перевірити чернетку

У звичайному (не приватному) вікні задайте для поточного PowerShell однакову
адресу, яку введете у форму реєстрації:

```powershell
$testAuthorEmail = 'zagulyaky.author.local@example.test'
```

1. У браузері відкрийте `http://localhost:5173/`, оберіть реєстрацію та
   створіть автора з адресою `$testAuthorEmail` і новим локальним паролем.
   Не використовуйте реальну адресу або production-пароль.
2. Якщо UI попросить підтвердити email, відкрийте локальний Mailpit:
   `http://127.0.0.1:54324`, знайдіть лист цього автора та перейдіть за
   підтверджувальним посиланням. Це локальна скринька, не реальний email.
3. Після входу відкрийте `http://localhost:5173/zahuliaky/my` і натисніть
   `+ Додати запис`.
4. Створіть вигадану особу, наприклад:
   - коротка назва: `Локальна чернетка: Іван Тестов, 1891`;
   - ПІБ мовою джерела: `Іван Тестов`;
   - тип події: `Народження`;
   - місце знахідки: `с. Демівка`;
   - підстава: `Локальна перевірка ручного workflow`;
   - архівний шифр: `ф. demo, оп. 1, спр. 1`.
5. Натисніть `Зберегти чернетку`, але ще не подавайте її. Вона має з'явитися
   тільки у `Мої записи` поточного автора. Повторіть крок 1 з приватного
   вікна: чернетки не повинно бути в публічному каталозі або пошуку.

### Приватне вкладення та авторська черга очищення

Для тесту не використовуйте реальний документ. Нижче створюється валідна
однопіксельна PNG-картинка у `%TEMP%`:

```powershell
$reviewAttachment = Join-Path $env:TEMP 'zagulyaky-local-review.png'
$removeAttachment = Join-Path $env:TEMP 'zagulyaky-local-remove.png'
$png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9oT9sAAAAASUVORK5CYII=')
[System.IO.File]::WriteAllBytes($reviewAttachment, $png)
[System.IO.File]::WriteAllBytes($removeAttachment, $png)
```

1. У відкритій чернетці натисніть `Додати вкладення`, виберіть
   `$reviewAttachment` і дочекайтеся повідомлення, що файл збережено
   приватно. Лишіть його в чернетці для модераторського тесту нижче.
2. Для перевірки cleanup додайте `$removeAttachment`, а потім натисніть
   `Вилучити` біля нього. Запис про вкладення має одразу зникнути з форми.
   Повідомлення `...поставлено в безпечну чергу очищення` означає, що сама
   чернетка вже коректно оновлена, а Edge worker завершить фізичне видалення
   повторною спробою за потреби.
3. Не шукайте Storage path у браузері: це навмисно не частина клієнтського
   контракту. Для безпечної локальної діагностики без виведення шляхів можна
   перевірити лише агреговані стани черги:

   ```powershell
   npm.cmd exec -- supabase db query --local "select storage_bucket, status, count(*) as tasks from public.zagulyaky_storage_cleanup_queue group by storage_bucket, status order by storage_bucket, status;"
   ```

   За запущеної функції з кроку 3.1 коротка author-дія `process_mine` зазвичай
   завершує private task відразу; за тимчасового збою він лишається в
   `queued`/`retry` і буде безпечно повторений worker-ом.

Для подання поставте позначку про право передати матеріал і натисніть
`Передати на модерацію`. Статус у `Мої записи` має стати
`Очікує перевірки`; редагування напряму більше недоступне до рішення
модератора.

## 6. Тимчасово надати роль модератора тільки локальному тестовому автору

Поточна модель RBAC навмисно має дві умови: дозволи `zagulyaky.moderate` /
`zagulyaky.import` і legacy-ознаку `public.app_admins`. Тому одного запису в
`admin_role_assignments` недостатньо. Додавання до `app_admins` запускає
сумісний тригер, який надає **локальну `super_admin`** роль.

Наступний блок безпечний для цього сценарію, тому що:

- команда явно має `--local`;
- допускається тільки новий `@example.test` тестовий користувач;
- SQL спершу перевіряє, що існують автор і його profile;
- він не змінює пароль, Auth конфігурацію або дані будь-якого іншого автора.

Він все одно надає повний адміністративний доступ **у локальній БД**, тож не
виконуйте його за межами локального тесту.

```powershell
if ($testAuthorEmail -notmatch '^[a-z0-9._%+-]+@example\.test$') {
  throw 'Для локального admin grant використовуйте новий @example.test акаунт.'
}

$grantFile = Join-Path $env:TEMP 'zagulyaky-local-grant-admin.sql'
$grantSql = @"
do `$grant`$
declare
  target_user uuid;
begin
  select id into target_user
  from auth.users
  where email = '$testAuthorEmail';

  if target_user is null then
    raise exception 'LOCAL_TEST_USER_NOT_FOUND';
  end if;
  if not exists (select 1 from public.profiles where user_id = target_user) then
    raise exception 'LOCAL_TEST_PROFILE_NOT_READY';
  end if;

  insert into public.app_admins(user_id, granted_by)
  values (target_user, target_user)
  on conflict (user_id) do nothing;
end
`$grant`$;
"@
[System.IO.File]::WriteAllText($grantFile, $grantSql, [System.Text.UTF8Encoding]::new($false))
npm.cmd exec -- supabase db query --local --file $grantFile
Remove-Item -LiteralPath $grantFile -Force
```

У браузері вийдіть і ввійдіть знову (або зробіть hard refresh), потім відкрийте
`http://localhost:5173/admin/zagulyaky`. Якщо сторінка доступна і відображає
чергу, локальна роль та захищений admin RPC працюють.

## 7. Модерація, версії та аудит Stage 2

1. На `/admin/zagulyaky` залиште фільтр `Очікує перевірки` і відкрийте щойно
   поданий запис.
2. Для першого проходу оберіть `Повернути на уточнення`, введіть коментар
   щонайменше з трьох символів, наприклад `Додайте точніший шифр джерела`, і
   підтвердьте дію.
3. Поверніться до `/zahuliaky/my`. Запис має мати статус `Потрібні зміни` та
   бути доступним для редагування. Змініть, наприклад, назву або шифр, і знову
   подайте його на модерацію.
4. Знову відкрийте запис у `/admin/zagulyaky`:
   - оберіть відповідний рівень достовірності;
   - для цього вигаданого історичного запису оберіть приватність
     `Можна публікувати`;
   - публічну адресу можна лишити порожньою, щоб вона згенерувалась
     автоматично;
   - натисніть `Опублікувати` та підтвердьте дію.
5. У деталях модератора розкрийте:
   - `Версії запису` — мають бути знімки до/після редагування;
   - `Журнал модерації` — очікуються submit, request changes, повторний
     submit і publish;
   - `Системний аудит` — фіксує адмінську дію без Storage path або raw
     payload.
6. У новому приватному вікні перевірте, що опублікований запис з'явився у
   `/zahuliaky`, знаходиться пошуком і має публічну картку. Запис із draft,
   pending review або needs changes не повинен з'являтися там на жодному кроці.

### Модерація та публічна доставка вкладення

Цей сценарій використовує `$reviewAttachment`, залишене в чернетці вище.

1. Коли запис ще в admin-черзі, у блоці `Приватні вкладення` натисніть
   `Переглянути приватно`. Відкривається окрема короткочасна URL-адреса; автор
   або анонімний відвідувач не отримують bucket/path оригіналу.
2. Виконайте звичайний крок публікації запису, описаний вище. Після успіху
   поверніться до його admin-картки, натисніть `Створити публічну копію` біля
   вкладення та дочекайтеся повідомлення про контрольовану копію.
3. У новому приватному вікні заново відкрийте публічну картку запису. Вона має
   показати вкладення; відкриття видає лише короткочасне підписане посилання.
4. Поверніться до admin-картки й натисніть `Відкликати публічну копію`.
   Перезавантажте публічну картку: нового посилання там більше немає. Уже
   видане посилання може лишатися робочим до свого короткого строку дії — це
   очікувана властивість signed URL, а не повторне розкриття даних.
5. У `Журналі модерації` та `Системному аудиті` мають з'явитися
   `attachment_publish` і `attachment_revoke`, але без приватного Storage path.

Не ставте прапорець `може стосуватися живої людини` у базовому smoke test. Для
такого запису Stage 2 вимагає окремо зафіксувати дату та приватний доказ
документованої згоди в модераторській картці, перш ніж вибрати `Можна
публікувати` й публікувати. Це перевіряється DB trigger, а не лише UI.

### Окрема перевірка правила для потенційно живої особи

Використайте ще одну **цілком вигадану** чернетку, не базовий історичний
smoke-record.

1. Як автор створіть запис, позначте `Може стосуватися живої людини`,
   підтвердіть права та подайте його на модерацію.
2. У admin-картці оберіть `Можна публікувати` і спробуйте `Опублікувати` без
   записаної згоди. Очікувано дію заблокує пояснення про документовану згоду;
   запис не з'явиться у публічному каталозі.
3. Заповніть `Дата отримання згоди`, вигаданий приватний ідентифікатор на
   кшталт `LOCAL-CONSENT-001`, за потреби примітку, і натисніть
   `Зафіксувати згоду`. Сам доказ лишається доступним лише модератору.
4. Тепер оберіть `Можна публікувати` та завершіть публікацію. У картці має
   бути статус `Згоду зафіксовано`; публічний detail/search показуються лише
   поки цей задокументований дозвіл відповідає перевіреним даним.
5. Для перевірки захисного блокування створіть від імені автора приватне
   `Уточнити запис` типу `Приватність`, а в admin-розділі звернень завершіть
   його з дією `Негайно заблокувати публікацію`. Запис негайно зникає з
   публічного каталогу, а зафіксована згода переходить у відкликаний стан.

### Уточнення і кандидати на дублікати

Ці кроки не обов'язкові для швидкого smoke test, але покривають решту Stage 2.

1. Увійшовши як тестовий автор, відкрийте картку опублікованої демо-особи та
   натисніть `Уточнити запис`.
2. Оберіть `Виправлення`, введіть вигаданий текст щонайменше з 10 символів і
   надішліть його.
3. В admin-панелі відкрийте розділ звернень, оберіть новий запис,
   натисніть `Взяти в роботу`, додайте рішення й завершіть його через
   `Позначити вирішеним`. Звернення залишається приватним і не має
   автоматично редагувати публічну картку.
4. Для кандидата на дублікат дістаньте UUID свого опублікованого запису з
   локальної БД (це не друкує raw staging data):

   ```powershell
   npm.cmd exec -- supabase db query --local "select id, title, status, public_slug from public.zagulyaky_records where created_by = (select id from auth.users where email = '$testAuthorEmail') order by created_at desc limit 1;"
   ```

5. В admin-панелі відкрийте `Дублікати`, додайте пару з UUID власного запису
   та UUID демо-особи
   `10000000-0000-4000-8000-000000000001`, вкажіть оцінку й пояснення.
   Перевірте `Підтвердити дублікат`, а для недеструктивного smoke test
   завершіть запис кнопкою `Не дублі`. Не використовуйте `Об'єднати записи`
   у базовому тесті: воно навмисно змінює один з каталогових записів.

## 8. Stage 0: локальний Facebook JSON import

### Перевірити import Edge endpoint

Функція вже запущена єдиним локальним Edge Runtime з кроку 3.1. Local CLI
надає їй `SUPABASE_URL` і локальні ключі; не копіюйте service/secret key у
Vite, запит або `.env.local`.

Функція доступна за адресою:

```text
http://127.0.0.1:54321/functions/v1/zagulyaky-stage0-import
```

`verify_jwt = false` у локальному конфігу існує тільки для того, щоб CORS
`OPTIONS` дійшов до функції. Кожен `POST` усе одно перевіряє Bearer JWT,
`zagulyaky.import`, SHA-256 точних байтів і server-side RPC contract.

### Створити тільки вигаданий export та виконати dry run

Поверніться до PowerShell-вікна, де є `$localSupabaseUrl`,
`$localPublishableKey` і `$testAuthorEmail`. Пароль вводиться у пам'ять лише
на час локального Auth login, не записується у файл або історію команд.

```powershell
$securePassword = Read-Host 'Пароль локального test author' -AsSecureString
$plainPassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
try {
  $authBody = @{ email = $testAuthorEmail; password = $plainPassword } | ConvertTo-Json -Compress
  $login = Invoke-RestMethod `
    -Method Post `
    -Uri "$localSupabaseUrl/auth/v1/token?grant_type=password" `
    -Headers @{ apikey = $localPublishableKey } `
    -ContentType 'application/json' `
    -Body $authBody
} finally {
  $plainPassword = $null
  Remove-Variable securePassword -ErrorAction SilentlyContinue
}
if (-not $login.access_token) { throw 'Локальний Auth не повернув access_token.' }

$jsonPath = Join-Path $env:TEMP 'zagulyaky-stage0-local-demo.json'
$json = @'
{
  "exportedAt": "2026-08-19T12:00:00Z",
  "posts": [
    {
      "postId": "local-stage0-doc-001",
      "text": "Вигаданий локальний допис для перевірки приватного staging.",
      "author": "Локальний тестовий автор",
      "publishedAt": "2026-08-18T12:00:00Z",
      "url": "https://example.test/posts/local-stage0-doc-001",
      "groupUrl": "https://example.test/groups/local-zagulyaky",
      "years": [1891],
      "images": [],
      "links": []
    }
  ]
}
'@
[System.IO.File]::WriteAllText($jsonPath, $json, [System.Text.UTF8Encoding]::new($false))

$checksum = (Get-FileHash -LiteralPath $jsonPath -Algorithm SHA256).Hash.ToLowerInvariant()
$importUri = "$localSupabaseUrl/functions/v1/zagulyaky-stage0-import"
$importHeaders = @{
  apikey = $localPublishableKey
  Authorization = "Bearer $($login.access_token)"
  'x-zagulyaky-import-mode' = 'dry_run'
  'x-zagulyaky-source-file-name' = [System.IO.Path]::GetFileName($jsonPath)
  'x-zagulyaky-source-checksum' = $checksum
}

$dryRun = Invoke-RestMethod `
  -Method Post `
  -Uri $importUri `
  -Headers $importHeaders `
  -ContentType 'application/json' `
  -InFile $jsonPath

$dryRun
```

Перший clean запуск очікувано повертає `accepted: true`, `replayed: false` і
batch metadata. Повторна відправка того самого exact-byte export може коректно
повернути `replayed: true`: це ідемпотентний retry, а не новий import. Dry run
не повинен додати нову публічну людину, документ, Storage object або зв'язок
staging → catalogue record.

### Commit того самого exact-byte файла

Commit можливий тільки після чистого dry run з **тим самим** файлом і
checksum. Не переформатковуйте JSON, не міняйте переводи рядка й не генеруйте
хеш повторно від нового вмісту між цими двома запитами.

```powershell
$importHeaders['x-zagulyaky-import-mode'] = 'commit'
$commit = Invoke-RestMethod `
  -Method Post `
  -Uri $importUri `
  -Headers $importHeaders `
  -ContentType 'application/json' `
  -InFile $jsonPath

$commit
```

Після `commit` перевірте тільки безпечну статистику та відсутність
автоматичного каталогового зв'язку. Не робіть `select raw_payload` і не
виводьте тестові або реальні Facebook-дані в консоль.

```powershell
$batchId = $commit.batch.batchId
if (-not $batchId) { throw 'Commit не повернув batchId.' }

$stage0Check = @"
select
  batch.id,
  batch.status,
  batch.import_mode,
  batch.processed_item_count,
  batch.staged_item_count,
  (select count(*) from public.zagulyaky_ingestion_item_errors error_row where error_row.batch_id = batch.id) as item_error_count,
  (
    select count(*)
    from public.zagulyaky_ingestion_batch_items batch_item
    join public.zagulyaky_ingestion_item_records record_link on record_link.item_id = batch_item.item_id
    where batch_item.batch_id = batch.id
  ) as automatic_catalogue_link_count
from public.zagulyaky_ingestion_batches batch
where batch.id = '$batchId';
"@
npm.cmd exec -- supabase db query --local $stage0Check

Remove-Item -LiteralPath $jsonPath -Force
Remove-Variable login, dryRun, commit -ErrorAction SilentlyContinue
```

Очікування для цього test payload: `status = completed`, один staged item,
нуль `item_error_count` і `automatic_catalogue_link_count = 0`. Останнє —
важлива межа Stage 0: importer лише ставить material у private quarantine; він
ніколи не створює та не публікує запис каталогу автоматично.

Якщо `dry_run` повертає `IMPORT_PERMISSION_REQUIRED`, перевірте, що крок 6
виконано в тій самій **локальній** БД, а токен належить саме цьому тестовому
автору. Якщо `SOURCE_CHECKSUM_MISMATCH`, повторіть dry run з незміненим файлом
та заголовком, обчисленим від цього самого файлу.

## 9. SEO, canonical URL і sitemap

Для SPA metadata з'являється після виконання JavaScript, тому інспектуйте її в
відкритому браузері, а не через `Invoke-WebRequest` HTML shell.

На кожному маршруті відкрийте DevTools Console та виконайте:

```javascript
({
  title: document.title,
  canonical: document.querySelector('link[rel="canonical"]')?.href,
  robots: document.querySelector('meta[name="robots"]')?.content,
})
```

Очікування:

| Відкритий локально маршрут | Canonical | Robots |
| --- | --- | --- |
| `/zahuliaky` | `https://trekerrodu.com.ua/zahuliaky` | `index, follow` |
| `/zahuliaky/documents` | `https://trekerrodu.com.ua/zahuliaky/documents` | `index, follow` |
| `/zahuliaky/people/demo-mariia-testova-1891` | production canonical detail URL | `index, follow` |
| `/zahuliaky/my` | `https://trekerrodu.com.ua/zahuliaky/my` | `noindex, nofollow, noarchive` |

Production canonical origin на localhost — очікувана поведінка цього
public-site SEO contract; це не причина запускати deployment.

Для локальної генерації dynamic sitemap використовуйте тільки отримані в
кроці 3 loopback URL та publishable key. Скрипт відмовляється працювати із
service/secret key і створює файл у `%TEMP%`, а не в `public/`:

```powershell
$env:ZAGULYAKY_SITEMAP_SUPABASE_URL = $localSupabaseUrl
$env:ZAGULYAKY_SITEMAP_PUBLISHABLE_KEY = $localPublishableKey
$localSitemap = Join-Path $env:TEMP 'sitemap-zagulyaky.local.xml'

node .\scripts\generate-zagulyaky-sitemap.mjs --output $localSitemap
Get-Content -LiteralPath $localSitemap
```

У файлі очікуються canonical detail URL демо-особи й демо-документа; там не
повинно бути `/zahuliaky/my`, private drafts, record title, author id або
staging даних. Статичні public-файли також повинні містити лише public entry
points:

```powershell
Select-String -LiteralPath .\public\robots.txt -Pattern 'Sitemap: https://trekerrodu.com.ua/sitemap-zagulyaky.xml'
Select-String -LiteralPath .\public\sitemap.xml -Pattern 'https://trekerrodu.com.ua/zahuliaky'
```

## 10. Автоматичні перевірки та завершення локального тесту

Після запуску Docker виконайте щонайменше такі перевірки:

```powershell
node --test `
  test/zagulyakyStage0Import.test.ts `
  test/zagulyakyRoutes.test.ts `
  test/zagulyakySitemap.test.ts `
  test/zagulyakyModerationWorkflows.test.ts `
  test/zagulyakyPrivacyAttachmentDelivery.test.ts `
  test/zagulyakyPrivacyIntegrity.test.ts `
  test/zagulyakyStorageCleanup.test.ts `
  test/zagulyakyClientStorageCleanup.test.ts

npm.cmd run test:db
npm.cmd run typecheck
npm.cmd run build
```

`test:db` потребує працюючого Docker/Supabase локально. Він перевіряє SQL/RLS
контракти, тому не замінюйте його лише статичними TypeScript-тестами.

Після завершення приберіть локальний admin grant, але не видаляйте автора або
його записи, якщо вони потрібні для повторної перевірки. Команда видаляє лише
власне тимчасову `app_admins` ознаку і відповідну auto-created `super_admin`
assignment цього свіжого `@example.test` автора:

```powershell
if ($testAuthorEmail -notmatch '^[a-z0-9._%+-]+@example\.test$') {
  throw 'Відмова: cleanup дозволений лише для локального @example.test акаунта.'
}

$revokeFile = Join-Path $env:TEMP 'zagulyaky-local-revoke-admin.sql'
$revokeSql = @"
do `$revoke`$
declare
  target_user uuid;
begin
  select id into target_user
  from auth.users
  where email = '$testAuthorEmail';

  if target_user is not null then
    delete from public.app_admins where user_id = target_user;
    delete from public.admin_role_assignments
    where user_id = target_user and role_code = 'super_admin';
  end if;
end
`$revoke`$;
"@
[System.IO.File]::WriteAllText($revokeFile, $revokeSql, [System.Text.UTF8Encoding]::new($false))
npm.cmd exec -- supabase db query --local --file $revokeFile
Remove-Item -LiteralPath $revokeFile -Force
```

У браузері вийдіть/увійдіть знову й переконайтеся, що
`/admin/zagulyaky` більше не відкривається для цього автора. Щоб зупинити
локальний стек без стирання локальної БД, коли всі перевірки завершено:

```powershell
npm.cmd exec -- supabase stop
```

Не запускайте цей документ як інструкцію для production deployment: тут немає
`link`, `push` або `deploy` кроку навмисно.
