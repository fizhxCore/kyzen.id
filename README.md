# Kyzen API

REST API canvas image generation — Express.js, deploy ke Vercel sebagai satu serverless function.

## Struktur

```
index.js                 # entry point — load semua route, middleware, admin API
src/
  api/
    canvas/               # semua endpoint canvas image generation
  middleware/
    auth.js                # dev key (admin) + API key untuk endpoint terproteksi
    maintenance.js          # maintenance mode toggle
  utils/
    redis.js                # wrapper Upstash Redis (aman kalau belum di-setup)
    stats.js                 # tracking traffic & error per endpoint
    errorlog.js               # log error terakhir (buat admin panel)
    routeRegistry.js           # status load route saat boot
    logger.js                   # console log + notifikasi Discord webhook (opsional)
  openapi.json              # sumber data endpoint — dipakai homepage & dashboard admin
api-page/
  index.html                # homepage + dokumentasi (dinamis, baca dari /openapi.json)
  dashboard.html             # panel admin
  dashboard-login.html        # gerbang login admin
  404.html / 500.html / maintenance.html
```

## Menjalankan lokal

```bash
npm install
DEV_SECRET=rahasia npm start
```

Buka `http://localhost:4000` untuk dokumentasi, `http://localhost:4000/dev/dashboard?key=rahasia` untuk admin panel.

## Environment variables

| Variable | Wajib? | Keterangan |
|---|---|---|
| `DEV_SECRET` | ya (buat akses admin) | Key buat masuk `/dev/dashboard` dan semua `/dev/api/*` |
| `UPSTASH_REDIS_REST_URL` | opsional | Kalau kosong, traffic stats & error log fallback ke memory (hilang tiap restart) |
| `UPSTASH_REDIS_REST_TOKEN` | opsional | Pasangan dari URL di atas |
| `DISCORD_WEBHOOK_URL` | opsional | Notifikasi request/error ke Discord |

## Menambah endpoint baru

1. Buat file baru di `src/api/<kategori>/nama-endpoint.js`, export function `(app) => { app.get("/kategori/nama-endpoint", handler) }`
2. Tambahkan entry-nya ke `src/openapi.json` (tag kategori, parameter, deskripsi) — ini yang bikin endpoint otomatis muncul di homepage & dashboard admin
3. Kalau endpoint butuh proteksi API key, tambahkan prefix/path-nya ke `PROTECTED_PREFIXES` / `PROTECTED_EXACT` di `src/middleware/auth.js`

## Admin panel

Akses: `/dev/dashboard?key=DEV_SECRET`

- **Overview** — traffic hari ini/all-time, grafik 24 jam, endpoint tersibuk
- **Endpoints** — semua endpoint dikelompokkan per kategori, dengan indikator kesehatan: 🟢 aman, 🟡 rawan error, 🔴 error (dihitung dari rasio error per endpoint)
- **Error Log** — 50 error terakhir lengkap dengan pesan asli, method, path, dan sumbernya
- **API Keys** — generate/revoke API key untuk endpoint terproteksi
- **System** — versi Node, uptime, memory, status Redis, dan status load route saat boot

## License

MIT
