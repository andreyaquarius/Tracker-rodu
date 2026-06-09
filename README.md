# Трекер Роду

**Не губи сліди свого роду**

Робочий простір для генеалогічного дослідження. Ведіть осіб, документи, завдання, знахідки, гіпотези та прогалини по роках в одному місці.

Застосунок працює без власного сервера: кожна зміна одразу зберігається у браузері, а після підключення Google автоматично синхронізується з прихованим файлом `tracker-rodu-db.json` у `appDataFolder`.

## Локальний запуск

```bash
npm install
copy .env.example .env
npm run dev
```

Для перевірки готової збірки:

```bash
npm run build
npm run preview
```

Без налаштованого Google OAuth Трекер Роду повністю працює локально, включно з JSON-експортом та імпортом.

## Налаштування Google Cloud

1. Відкрийте [Google Cloud Console](https://console.cloud.google.com/) і створіть новий проєкт.
2. У **APIs & Services → Library** знайдіть і ввімкніть **Google Drive API**.
3. Налаштуйте **Google Auth Platform** і вкажіть назву застосунку **Трекер Роду**. Для тестового застосунку додайте свій Google-акаунт до тестових користувачів.
4. У **Google Auth Platform → Clients** створіть OAuth Client ID типу **Web application** з назвою **Трекер Роду Local**.
5. Додайте дозволені джерела JavaScript:
   - `http://localhost:5173` для локального запуску;
   - адресу сайту Netlify або Vercel;
   - для робочого сайту: `https://trekerrodu.com.ua`;
   - для сумісності можна також додати `https://www.trekerrodu.com.ua`.
6. Скопіюйте Client ID у `.env`:

```env
VITE_GOOGLE_CLIENT_ID=000000000000-example.apps.googleusercontent.com
VITE_GOOGLE_API_KEY=
```

`VITE_GOOGLE_API_KEY` зарезервовано для можливого розширення, але поточна реалізація його не потребує.

## Дозволи Google

Основний вхід запитує:

- `openid`
- `profile`
- `email`
- `https://www.googleapis.com/auth/drive.appdata`

Трекер Роду не просить повного доступу до Google Drive. Додатковий дозвіл `https://www.googleapis.com/auth/drive.file` запитується лише для створення видимої резервної копії.

Google Identity Services видає короткостроковий access token у браузері. Після завершення його строку дії синхронізація може вимагати повторного підключення Google. Локальне автозбереження продовжує працювати.

## Розміщення

### Netlify

1. Імпортуйте репозиторій.
2. Build command: `npm run build`.
3. Publish directory: `dist`.
4. Додайте `VITE_GOOGLE_CLIENT_ID` до Environment Variables.
5. Додайте адресу Netlify до Authorized JavaScript origins у Google Cloud.

### Vercel

1. Імпортуйте репозиторій як Vite-проєкт.
2. Build command: `npm run build`.
3. Output directory: `dist`.
4. Додайте `VITE_GOOGLE_CLIENT_ID` до Environment Variables.
5. Додайте адресу Vercel до Authorized JavaScript origins у Google Cloud.

### GitHub Pages

Збірка використовує відносний `base: "./"`, тому каталог `dist` можна публікувати на GitHub Pages. Додайте адресу GitHub Pages до OAuth Client ID.

## Зберігання та відновлення

- Локальний ключ: `tracker-rodu-local-db`.
- Службовий файл Google Drive: `tracker-rodu-db.json` у `appDataFolder`.
- Автосинхронізація: приблизно через 1,5 секунди після останньої зміни.
- Автоматична резервна копія: один раз на добу після відкриття з підключеним Google Drive.
- Зберігаються останні 7 автоматичних копій у `appDataFolder`.
- Перед імпортом або відновленням створюється захисна копія поточного стану.
- Видима резервна копія: `Трекер Роду backup YYYY-MM-DD HH-mm.json`.
- JSON-експорт та імпорт доступні в розділі **Резервні копії**.
- При різних локальній і Drive-версіях застосунок порівнює `updatedAt` та пропонує використати новішу.
- Скани документів і знахідок розміром до 2 ГБ при підключеному Google завантажуються частинами й зберігаються окремими файлами в `appDataFolder`. У локальному режимі вони зберігаються лише в цьому браузері та залежать від доступної квоти браузера.

Старі локальні дані та файл `rodovyi-navigator-db.json` автоматично переносяться до нових назв після першого запуску оновленої версії.

Поточна версія структури бази — `2`. Вона містить масиви `persons` і `personRelations`, а записи завдань, знахідок та гіпотез підтримують `personIds`. Бази версії `1` мігрують автоматично під час завантаження.

Офіційна документація: [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [appDataFolder](https://developers.google.com/workspace/drive/api/guides/appdata), [Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
