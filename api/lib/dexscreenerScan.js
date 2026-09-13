// lib/dexscreenerScan.js
// Logika scan token BARU/rame di 1 chain EVM/SVM via DexScreener public API —
// diekstrak dari scan.js supaya bisa dipakai ulang buat chain lain (Solana)
// tanpa duplikasi. Perilaku dan urutan sumber data PERSIS sama seperti
// scan.js Robinhood Chain yang asli:
// - Sumber UTAMA: /token-profiles/latest/v1 + /token-boosts/latest/v1,
//   difilter chainId cocok, lalu detail pair-nya diambil dari /tokens/v1.
// - Sumber PELENGKAP: /latest/dex/search?q=<seedQueries> buat nangkep pair
//   tambahan, base token yang ada di excludeAsBase (token mayor/quote,
//   bukan meme coin) dibuang.
// - Rate limit DexScreener free tier ~300 req/menit — jangan polling client
//   lebih cepat dari ~15-20 detik.

const DEXSCREENER_SEARCH = "https://api.dexscreener.com/latest/dex/search";
const DEXSCREENER_PROFILES = "https://api.dexscreener.com/token-profiles/latest/v1";
const DEXSCREENER_BOOSTS = "https://api.dexscreener.com/token-boosts/latest/v1";
const DEXSCREENER_TOKENS = "https://api.dexscreener.com/tokens/v1"; // /{chainId}/{addr1,addr2,...}

async function scanChain({ chainId, seedQueries, excludeAsBase, tab = "trending" }) {
  const seen = new Map();

  const [profiles, boosts] = await Promise.all([
    fetchJson(DEXSCREENER_PROFILES).catch(() => []),
    fetchJson(DEXSCREENER_BOOSTS).catch(() => []),
  ]);
  const freshAddrs = new Set();
  for (const item of [...(profiles || []), ...(boosts || [])]) {
    if (item && item.chainId === chainId && item.tokenAddress) {
      freshAddrs.add(item.tokenAddress);
    }
  }
  if (freshAddrs.size > 0) {
    const addrList = Array.from(freshAddrs).slice(0, 30).join(",");
    const pairsFromTokens = await fetchJson(`${DEXSCREENER_TOKENS}/${chainId}/${addrList}`).catch(() => []);
    for (const p of pairsFromTokens || []) {
      if (p.chainId === chainId && p.pairAddress && !seen.has(p.pairAddress)) {
        seen.set(p.pairAddress, p);
      }
    }
  }

  const searchResults = await Promise.all(
    seedQueries.map((q) => fetchJson(`${DEXSCREENER_SEARCH}?q=${encodeURIComponent(q)}`).catch(() => null))
  );
  for (const r of searchResults) {
    if (!r || !Array.isArray(r.pairs)) continue;
    for (const p of r.pairs) {
      if (p.chainId !== chainId) continue;
      if (!p.pairAddress) continue;
      const baseSym = ((p.baseToken && p.baseToken.symbol) || "").toUpperCase();
      if (excludeAsBase.has(baseSym)) continue;
      if (!seen.has(p.pairAddress)) seen.set(p.pairAddress, p);
    }
  }

  let tokens = Array.from(seen.values()).map(mapPair).filter(Boolean);
  tokens = sortForTab(tokens, tab);

  return { updatedAt: Date.now(), chain: chainId, count: tokens.length, tokens: tokens.slice(0, 60) };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("dexscreener_http_" + res.status);
  return res.json();
}

function mapPair(p) {
  try {
    const base = p.baseToken || {};
    const quote = p.quoteToken || {};
    const liq = (p.liquidity && p.liquidity.usd) || 0;
    const mcap = p.marketCap || p.fdv || 0;
    const vol24 = (p.volume && p.volume.h24) || 0;
    const chg = p.priceChange || {};
    const txns24 = (p.txns && p.txns.h24) || { buys: 0, sells: 0 };
    const buys = txns24.buys || 0;
    const sells = txns24.sells || 0;
    const totalTx = buys + sells;
    const buyPct = totalTx > 0 ? Math.round((buys / totalTx) * 100) : 50;

    const ageMin = p.pairCreatedAt ? Math.max(0, Math.round((Date.now() - p.pairCreatedAt) / 60000)) : null;

    const m5 = numOr(chg.m5, 0);
    const h1 = numOr(chg.h1, 0);
    const h6 = numOr(chg.h6, 0);
    const h24 = numOr(chg.h24, 0);

    const spark = [50, clamp(50 + h24 / 4, 5, 95), clamp(50 + h6 / 2, 5, 95), clamp(50 + h1, 5, 95), clamp(50 + m5 * 2, 5, 95)];

    let score = 0;
    if (buyPct >= 55) score++;
    if (h24 > 0 && h1 > 0) score++;
    if (liq > 0 && vol24 / liq > 1.5) score++;
    if (liq >= 1_000_000) score++;
    const signal = Math.max(1, score);

    const image = (p.info && p.info.imageUrl) || base.imageUrl || null;

    return {
      id: p.pairAddress,
      ticker: (base.symbol || "?").toUpperCase(),
      name: base.name || base.symbol || "Unknown",
      image,
      sub: `${p.dexId || "dex"} · vs ${quote.symbol || "?"}`,
      mcap,
      liq,
      buy: buyPct,
      sell: 100 - buyPct,
      m5,
      h1,
      h24,
      volume: vol24,
      ageMin,
      spark,
      signal,
      url: p.url || null,
    };
  } catch {
    return null;
  }
}

function sortForTab(tokens, tab) {
  const t = tokens.slice();
  if (tab === "new") {
    t.sort((a, b) => (a.ageMin ?? 1e9) - (b.ageMin ?? 1e9));
  } else if (tab === "gainers") {
    return t.filter((x) => x.h24 >= 0).sort((a, b) => b.h24 - a.h24);
  } else if (tab === "losers") {
    return t.filter((x) => x.h24 < 0).sort((a, b) => a.h24 - b.h24);
  } else {
    t.sort((a, b) => b.volume - a.volume);
  }
  return t;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = { scanChain };
