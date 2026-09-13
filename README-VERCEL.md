# Deploy ke Vercel (region Singapura)

## Struktur
- `index.html`, `preview.html`, `reviews.html` — static frontend (di-serve langsung, tanpa `publish` dir seperti Netlify).
- `api/*.js` — Vercel Serverless Functions (dulu `netlify/functions/*.js`).
  Vercel otomatis treat tiap file di `api/` sebagai endpoint: `api/analyze.js` -> `/api/analyze`, dst.
- `vercel.json` — set region function ke `sin1` (Singapura) + `maxDuration` buat endpoint yang manggil Groq (`analyze`, `analyze-dex`).

## Langkah deploy
1. Push folder ini ke repo Git (GitHub/GitLab/Bitbucket), lalu import project di https://vercel.com/new.
   Atau pakai CLI: `npm i -g vercel` lalu `vercel` di dalam folder ini.
2. Di dashboard Vercel project ini, buka **Settings → Environment Variables**, isi ulang semua env var
   yang dulu dipasang di Netlify (Groq key, dst) — env var Netlify TIDAK ikut pindah otomatis:
   - `GROQ_API_KEY` (atau `GROQ_KEYS` / `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, dst kalau pakai multi-key)
   - `GROQ_MODEL`, `GROQ_VISION_MODEL`, `GROQ_REASONING_EFFORT`, `GROQ_TIMEOUT_MS` (opsional, ada default)
   - `BIRDEYE_API_KEY` (dipakai di `lib/marketdata.js`, kalau ada)
3. Region function sudah di-set `sin1` (Singapore) lewat `vercel.json`. Kalau mau ganti/verifikasi manual:
   **Settings → Functions → Function Region**.
4. Redeploy setelah env var diisi (env var baru butuh deploy ulang biar kepakai).

## Yang berubah dari versi Netlify
- `exports.handler = async (event) => {...}` → `module.exports = async (req, res) => {...}` (signature Vercel).
- `event.httpMethod` → `req.method`; `event.queryStringParameters` → `req.query`; `event.body` (string) →
  `req.body` (sudah di-parse Vercel, ditangani lewat helper `api/lib/http.js`).
- Return `{ statusCode, body }` → `res.status(...).json(...)`.
- Frontend fetch: `/.netlify/functions/xxx` → `/api/xxx`.
- Tidak butuh `netlify.toml` lagi — konfigurasi setara ada di `vercel.json`.
- Semua logic bisnis di `api/lib/*.js` (indicators, generate signal, dexscreener, groq, marketdata) TIDAK diubah sama sekali.
