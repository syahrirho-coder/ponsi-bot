// api/binance-futures.js (Vercel Serverless Function)
// Scan SEMUA pair Binance Futures USDT-M Perpetual lewat endpoint publik
// Binance sendiri — gak butuh API key. Diganti dari Bybit karena Bybit
// nge-block request dari IP Netlify Functions (403 confirmed dari log),
// sedangkan Binance TERBUKTI gak kena block dari akun Netlify yang sama
// (dipakai langsung juga di project Signalynx tanpa masalah). Sekarang
// pindah ke Vercel region Singapura (sin1) — cek vercel.json.
//
// 3 request BULK (semua tanpa param symbol = data buat SEMUA pair sekaligus):
// - GET /fapi/v1/ticker/24hr   -> harga, open/high/low (buat spark), 24h%, volume
// - GET /fapi/v1/premiumIndex  -> funding rate + mark price per pair
// - GET /fapi/v1/exchangeInfo  -> onboardDate (buat umur pair / tab "New pairs")

const BINANCE_FAPI = "https://fapi.binance.com";

module.exports = async function handler(req, res) {
  try {
    const tab = (req.query && req.query.tab) || "trending";

    const [tickers, premium, info] = await Promise.all([
      fetchJson(`${BINANCE_FAPI}/fapi/v1/ticker/24hr`),
      fetchJson(`${BINANCE_FAPI}/fapi/v1/premiumIndex`),
      fetchJson(`${BINANCE_FAPI}/fapi/v1/exchangeInfo`),
    ]);

    const onboardBySymbol = new Map();
    for (const s of (info && info.symbols) || []) {
      if (s.quoteAsset === "USDT" && s.contractType === "PERPETUAL" && s.status === "TRADING") {
        onboardBySymbol.set(s.symbol, Number(s.onboardDate) || null);
      }
    }

    const premiumBySymbol = new Map();
    for (const p of Array.isArray(premium) ? premium : []) {
      premiumBySymbol.set(p.symbol, p);
    }

    let pairs = (Array.isArray(tickers) ? tickers : [])
      .filter((t) => onboardBySymbol.has(t.symbol))
      .map((t) => mapTicker(t, onboardBySymbol.get(t.symbol), premiumBySymbol.get(t.symbol)))
      .filter(Boolean);

    pairs = sortForTab(pairs, tab);

    res.setHeader("Cache-Control", "public, max-age=15");
    return res.status(200).json({
      updatedAt: Date.now(),
      count: pairs.length,
      pairs,
    });
  } catch (err) {
    console.error("binance-futures function error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "bybit_scan_failed", message: String((err && err.message) || err) });
  }
};

async function fetchJson(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!res.ok) {
      // 451 = Binance nge-block request dari region IP ini (paling sering kejadian
      // di infra cloud kayak Netlify/AWS us-east-1). 403 biasanya rate-limit/WAF.
      if (res.status === 451) {
        throw new Error("binance_blocked_region_451 — IP function Netlify keblokir Binance, coba pindah region function atau pakai proxy");
      }
      throw new Error("binance_http_" + res.status);
    }
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

function mapTicker(t, onboardDate, premiumItem) {
  try {
    const price = Number(t.lastPrice);
    const open = Number(t.openPrice);
    const high = Number(t.highPrice);
    const low = Number(t.lowPrice);
    const h24 = Number(t.priceChangePercent);
    const volumeUsd = Number(t.quoteVolume);
    const up = h24 >= 0;
    const ageMin = onboardDate ? Math.max(0, Math.round((Date.now() - onboardDate) / 60000)) : null;

    const lo = Math.min(open, low, high, price);
    const hi = Math.max(open, low, high, price);
    const order = up ? [open, low, high, price] : [open, high, low, price];
    const spark = order.map((v) => clamp(norm(v, lo, hi), 5, 95));

    const fundingRate = premiumItem && premiumItem.lastFundingRate !== undefined ? Number(premiumItem.lastFundingRate) * 100 : null;
    const markPrice = premiumItem && premiumItem.markPrice !== undefined ? Number(premiumItem.markPrice) : null;

    let score = 0;
    if (volumeUsd >= 50_000_000) score++;
    if (Math.abs(h24) >= 3) score++;
    if (fundingRate !== null) {
      const fundingBearishForLongs = fundingRate > 0.01;
      const fundingBearishForShorts = fundingRate < -0.01;
      if ((up && fundingBearishForLongs) || (!up && fundingBearishForShorts)) score++;
      if (Math.abs(fundingRate) >= 0.03) score++;
    }

    const ticker = String(t.symbol || "").replace(/USDT$/, "");

    return {
      id: t.symbol,
      ticker,
      name: t.symbol,
      sub: "Binance Futures · USDT Perpetual",
      image: `https://assets.coincap.io/assets/icons/${ticker.toLowerCase()}@2x.png`,
      price,
      markPrice,
      fundingRate,
      h24,
      volume: volumeUsd,
      ageMin,
      spark,
      signal: Math.max(0, score),
      url: `https://www.binance.com/en/futures/${t.symbol}`,
    };
  } catch {
    return null;
  }
}

function norm(v, lo, hi) {
  return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sortForTab(pairs, tab) {
  const p = pairs.slice();
  if (tab === "new") {
    p.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
  } else if (tab === "gainers") {
    return p.filter((x) => x.h24 >= 0).sort((a, b) => b.h24 - a.h24);
  } else if (tab === "losers") {
    return p.filter((x) => x.h24 < 0).sort((a, b) => a.h24 - b.h24);
  } else {
    p.sort((a, b) => b.volume - a.volume); // trending
  }
  return p;
}
