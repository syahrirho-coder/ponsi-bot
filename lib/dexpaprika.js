// lib/dexpaprika.js
// Candle data buat token DEX (Robinhood Chain, Solana) lewat DexPaprika
// Public API — GRATIS, gak butuh API key, no signup. Ganti dari GeckoTerminal
// karena DexPaprika:
// - Limit jauh lebih longgar (200K request/bulan vs ~30 req/menit GeckoTerminal)
// - Punya granularity 30 menit ASLI (GeckoTerminal gak punya, dulu dipaksa
//   pakai candle 15m sebagai gantinya)
// - Network id sama persis: "robinhood" dan "solana"
//
// Beda dari GeckoTerminal: DexPaprika WAJIB parameter "start" (timestamp
// mulai jendela candle), gak cukup cuma "limit". Jadi di sini kita hitung
// mundur dari sekarang: start = now - (interval * jumlah candle yang diminta).

const DP_API = "https://api.dexpaprika.com";

// Detik per 1 candle, dipakai buat ngitung mundur parameter "start".
const INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 300,
  "10m": 600,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "6h": 21600,
  "12h": 43200,
  "24h": 86400,
};

const STYLE_TO_GT = {
  m1: { interval: "1m", label: "M1" },
  m5: { interval: "5m", label: "M5" },
  m30: { interval: "30m", label: "M30" }, // sekarang candle 30m ASLI, bukan approksimasi 15m
  scalping: { interval: "15m", label: "M15" },
  daytrade: { interval: "1h", label: "H1" },
  // "swing" SENGAJA gak dipetakan di sini lagi — style itu sekarang di-route
  // ke GeckoTerminal (lib/geckoterminal.js) karena butuh candle H4 ASLI yang
  // gak dipunyai DexPaprika. Lihat GECKOTERMINAL_STYLES di generateDex.js.
};

async function fetchPoolOhlcv(network, poolAddress, style, limit = 150) {
  const cfg = STYLE_TO_GT[style] || STYLE_TO_GT.scalping;
  const intervalSec = INTERVAL_SECONDS[cfg.interval];
  const startUnix = Math.floor(Date.now() / 1000) - intervalSec * limit;

  const url = `${DP_API}/networks/${network}/pools/${poolAddress}/ohlcv?start=${startUnix}&interval=${cfg.interval}&limit=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`DexPaprika OHLCV timeout untuk pool ${poolAddress}.`);
    throw new Error(`Gagal mengambil candle DexPaprika: ${err.message}`);
  }
  clearTimeout(timer);

  const json = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(json)) {
    const msg = json && json.error ? json.error : `HTTP ${res.status}`;
    throw new Error(`DexPaprika tidak mengembalikan candle untuk pool ini: ${msg} (mungkin pool terlalu baru/kecil).`);
  }

  // Urutin manual jadi kronologis (lama -> baru) — jangan asumsi urutan API,
  // biar konsisten sama format candle yang dipakai computeIndicators.
  return json
    .slice()
    .sort((a, b) => new Date(a.time_open) - new Date(b.time_open))
    .map((row) => ({
      time: row.time_open,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }));
}

module.exports = { fetchPoolOhlcv, STYLE_TO_GT };
