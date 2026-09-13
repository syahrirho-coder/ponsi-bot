// lib/geckoterminal.js
// Awalnya cuma dipakai buat H4 (DexPaprika gak punya interval itu secara
// asli), TAPI sekarang juga dipakai sebagai FALLBACK buat semua style kalau
// DexPaprika gagal/candle-nya kurang — soalnya indexing on-chain DexPaprika
// kadang belum lengkap buat pool yang BARU BANGET launch atau likuiditasnya
// kecil. GeckoTerminal infrastruktur indexing-nya BEDA (dipakai luas oleh
// CoinGecko), jadi ada kemungkinan pool yang gagal di satu provider ternyata
// udah ke-index di provider satunya — TAPI INI GAK DIJAMIN DUA ARAH: pool
// yang bener-bener baru banget (baru sedetik/menit launch) bisa aja BELUM
// ke-index di provider MANAPUN, karena keduanya sama-sama nunggu on-chain
// indexer jalan, cuma beda kecepatan/infra masing-masing.
//
// GeckoTerminal onchain API: gratis, TANPA key, tapi limit ketat (~30
// request/menit) — makanya provider ini dipakai sebagai FALLBACK, bukan
// pengganti DexPaprika buat semuanya (biar limit longgar DexPaprika tetap
// jadi jalur utama).
// Endpoint & aggregate value per dokumentasi resmi GeckoTerminal:
// https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool_address}/ohlcv/{timeframe}?aggregate=N
//   timeframe "minute" -> aggregate valid: 1, 5, 15
//   timeframe "hour"   -> aggregate valid: 1, 4, 12   (4 = H4 asli)
//   timeframe "day"    -> aggregate valid: 1           (1 = 1D/24h asli)
//
// PENTING: network id di GeckoTerminal TIDAK SELALU sama persis dengan
// DexPaprika (mis. "robinhood" di DexPaprika belum tentu id yang sama di
// GeckoTerminal — chain baru kadang punya slug beda antar provider).
// Kalau chain baru gagal di sini, cek dulu id yang benar di
// https://api.geckoterminal.com/api/v2/networks (daftar semua network id
// yang GeckoTerminal kenal) sebelum asumsikan endpoint ini salah.

const GT_API = "https://api.geckoterminal.com/api/v2";

// Dipetakan buat SEMUA style (bukan cuma swing) supaya bisa jadi fallback
// utuh — 30m gak ada aggregate asli di GeckoTerminal (cuma 1/5/15 buat
// "minute" dan 1/4/12 buat "hour"), jadi didekati pakai H1 sebagai fallback
// TERDEKAT, bukan approksimasi yang sama presisinya kayak style lain.
const STYLE_TO_GECKOTERMINAL = {
  m1: { timeframe: "minute", aggregate: 1, label: "M1 (GeckoTerminal)" },
  m5: { timeframe: "minute", aggregate: 5, label: "M5 (GeckoTerminal)" },
  scalping: { timeframe: "minute", aggregate: 15, label: "M15 (GeckoTerminal)" },
  m30: { timeframe: "hour", aggregate: 1, label: "H1 (fallback approksimasi M30 — GeckoTerminal gak punya 30m asli)" },
  daytrade: { timeframe: "hour", aggregate: 1, label: "H1 (GeckoTerminal)" },
  swing: { timeframe: "hour", aggregate: 4, label: "H4 (candle 4 jam asli — GeckoTerminal)" },
  "1d": { timeframe: "day", aggregate: 1, label: "1D (candle 24 jam asli — GeckoTerminal)" },
};

async function fetchPoolOhlcvGT(network, poolAddress, style, limit = 150) {
  const cfg = STYLE_TO_GECKOTERMINAL[style];
  if (!cfg) throw new Error(`Style "${style}" tidak dipetakan ke GeckoTerminal.`);

  const url = `${GT_API}/networks/${network}/pools/${poolAddress}/ohlcv/${cfg.timeframe}?aggregate=${cfg.aggregate}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`GeckoTerminal OHLCV timeout untuk pool ${poolAddress}.`);
    throw new Error(`Gagal mengambil candle GeckoTerminal: ${err.message}`);
  }
  clearTimeout(timer);

  if (res.status === 429) {
    throw new Error("GeckoTerminal rate limit tercapai (~30 request/menit) — coba lagi sebentar.");
  }

  const json = await res.json().catch(() => null);
  const rows = json?.data?.attributes?.ohlcv_list;
  if (!res.ok || !Array.isArray(rows)) {
    const msg = json?.errors?.[0]?.title || `HTTP ${res.status}`;
    throw new Error(`GeckoTerminal tidak mengembalikan candle untuk pool ini: ${msg} (cek juga apakah network id "${network}" valid di GeckoTerminal).`);
  }

  // ohlcv_list per dokumentasi: [timestamp_unix, open, high, low, close, volume],
  // urutan terbaru -> terlama, jadi dibalik dulu biar kronologis.
  return rows
    .slice()
    .reverse()
    .map(([ts, open, high, low, close, volume]) => ({
      time: new Date(ts * 1000).toISOString(),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));
}

module.exports = { fetchPoolOhlcvGT, STYLE_TO_GECKOTERMINAL };
