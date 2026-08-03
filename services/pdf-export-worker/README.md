# PDF stream/export worker

Окремий runtime для DNS-pinned Range-перегляду та векторного експорту сторінок
великих зовнішніх PDF. Він:

- приймає лише HMAC-підписані запити від `pdf-gateway`;
- перевіряє і фіксує публічну DNS-адресу для кожного redirect;
- завантажує оригінал потоком у приватний каталог системної `/tmp`;
- копіює вибрані сторінки через `qpdf` без растеризації;
- одразу stream-ить результат і видаляє каталог у `finally`;
- не записує URL, OAuth token або PDF у журнали чи постійне сховище.

Маршрути:

- `POST /v1/stream` — HMAC-підписаний `GET`/`HEAD` до збереженого джерела з
  `Range`/`If-Range`; без тимчасових файлів;
- `POST /v1/export` — HMAC-підписаний список сторінок, тимчасовий файл і `qpdf`;
- `GET /health` — стан процесу без приватних даних.

Локальний запуск:

```powershell
docker build -t tracker-rodu-pdf-export services/pdf-export-worker
docker run --rm -p 8085:8080 `
  -e PDF_EXPORT_WORKER_SECRET="replace-with-at-least-32-random-characters" `
  tracker-rodu-pdf-export
```

У Supabase Edge Function задайте той самий `PDF_EXPORT_WORKER_SECRET` і
`PDF_EXPORT_WORKER_URL=https://<private-worker-host>`. У production
worker має бути доступний лише через HTTPS; додатково обмежте ingress до
сервісного середовища, де виконується Edge Function.

Доступні ліміти worker:

```text
PDF_EXPORT_MAX_BODY_BYTES=65536
PDF_EXPORT_MAX_SOURCE_BYTES=2147483648
PDF_EXPORT_MAX_PAGES=250
PDF_EXPORT_MAX_CONCURRENT=2
PDF_EXPORT_DOWNLOAD_TIMEOUT_MS=900000
PDF_EXPORT_QPDF_TIMEOUT_MS=600000
PDF_EXPORT_MAX_REDIRECTS=5
PDF_STREAM_MAX_CONCURRENT=32
PDF_STREAM_MAX_RESPONSE_BYTES=33554432
```
