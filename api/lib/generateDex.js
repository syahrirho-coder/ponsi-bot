// lib/generateDex.js
// Analisa mendalam on-demand buat token DEX (Robinhood Chain / Solana),
// dipicu tombol "Analisa" di tabel scanner — pipeline-nya paralel sama
// lib/generate.js (Binance Futures), bedanya:
// - Candle dari DexPaprika (lib/dexpaprika.js), bukan dari exchange
//   terpusat, karena token DEX gak punya data di Binance/Bybit/OKX.
// - Gak ada funding rate/long-short/orderbook (itu konsep bursa futures,
//   gak ada di DEX) — sebagai gantinya dipakai data on-chain yang BENERAN
//   ada: liquidity, market cap/FDV, rasio buy/sell transaksi, umur pool,
//   dan volume — semua dikirim dari frontend (persis angka yang lagi
//   ditampilkan di baris tabel, bukan data baru yang diklaim).
const { computeIndicators } = require("./indicators");
const { fetchPoolOhlcv, STYLE_TO_GT } = require("./dexpaprika");
const { callGroq, SIGNAL_JSON_SPEC } = require("./groq");

function fmt(n, digits = 4) {
  return n === null || n === undefined || Number.isNaN(n) ? "n/a" : Number(n).toFixed(digits);
}

function buildIndicatorText(ind) {
  const lines = [
    `Harga saat ini: ${ind.price}`,
    `EMA20: ${fmt(ind.ema20)}`,
    `EMA50: ${fmt(ind.ema50)}`,
    `EMA100: ${fmt(ind.ema100)}`,
    `RSI14: ${fmt(ind.rsi14, 1)}`,
    `ATR14: ${fmt(ind.atr14)}`,
    `Swing high (rentang data): ${fmt(ind.swingHigh24)}`,
    `Swing low (rentang data): ${fmt(ind.swingLow24)}`,
    `Momentum streak candle terakhir: ${ind.momentumStreak}`,
    `MACD: ${ind.macd ? `line ${fmt(ind.macd.macd)}, signal ${fmt(ind.macd.signal)}, histogram ${fmt(ind.macd.histogram)}` : "n/a"}`,
    `Bollinger Bands (20,2): ${ind.bollinger ? `upper ${fmt(ind.bollinger.upper)}, middle ${fmt(ind.bollinger.middle)}, lower ${fmt(ind.bollinger.lower)}` : "n/a"}`,
    `Stochastic (14,3): ${ind.stochastic ? `%K ${fmt(ind.stochastic.k, 1)}, %D ${fmt(ind.stochastic.d, 1)}` : "n/a"}`,
    `ADX14 (kekuatan tren): ${fmt(ind.adx14, 1)}`,
    `VWAP: ${ind.vwap ? fmt(ind.vwap) : "n/a"}`,
    `Jumlah candle dianalisa: ${ind.candleCount}`,
  ];
  return lines.join("\n");
}

function buildOnChainText(ctx) {
  const lines = [];
  lines.push(`Chain: ${ctx.chainLabel}`);
  lines.push(ctx.mcap ? `Market cap / FDV: $${Number(ctx.mcap).toLocaleString("en-US")}` : "Market cap: n/a");
  lines.push(ctx.liq ? `Liquidity pool: $${Number(ctx.liq).toLocaleString("en-US")}` : "Liquidity: n/a");
  if (ctx.mcap && ctx.liq) {
    lines.push(`Rasio Liquidity/Mkt cap: ${((ctx.liq / ctx.mcap) * 100).toFixed(1)}% — ${ctx.liq / ctx.mcap < 0.03 ? "SANGAT TIPIS, risiko slippage & rug tinggi" : ctx.liq / ctx.mcap < 0.08 ? "tipis, hati-hati slippage di posisi besar" : "relatif sehat"}`);
  }
  lines.push(ctx.volume24 ? `Volume 24 jam: $${Number(ctx.volume24).toLocaleString("en-US")}` : "Volume 24 jam: n/a");
  if (ctx.buyPct !== undefined && ctx.sellPct !== undefined) {
    lines.push(`Rasio transaksi 24 jam: ${ctx.buyPct}% buy vs ${ctx.sellPct}% sell`);
  }
  lines.push(ctx.ageMin !== undefined && ctx.ageMin !== null ? `Umur pool: ${ctx.ageMin < 60 ? `${Math.round(ctx.ageMin)} menit` : `${(ctx.ageMin / 60).toFixed(1)} jam`}` : "Umur pool: n/a");
  if (typeof ctx.m5 === "number") lines.push(`Perubahan harga 5 menit: ${fmt(ctx.m5, 2)}%`);
  if (typeof ctx.h1 === "number") lines.push(`Perubahan harga 1 jam: ${fmt(ctx.h1, 2)}%`);
  if (typeof ctx.h24 === "number") lines.push(`Perubahan harga 24 jam: ${fmt(ctx.h24, 2)}%`);
  return lines.join("\n");
}

function buildDexSystemPrompt() {
  return `Kamu adalah mesin analisa teknikal trading untuk fitur "Analisa" token DEX (memecoin) di PONSI BOT. PENTING: ini token di DEX chain baru (Robinhood Chain atau Solana), BUKAN pair di bursa futures terpusat — jangan pernah menyebut funding rate, open interest, long/short ratio, atau orderbook exchange, karena data itu TIDAK ADA dan TIDAK RELEVAN untuk token DEX. Yang kamu punya cuma: (1) indikator teknikal dari candle harga on-chain (EMA/RSI/MACD/Bollinger/Stochastic/ADX/VWAP), dan (2) data on-chain: market cap/FDV, liquidity pool, rasio liquidity terhadap mcap, volume 24 jam, rasio transaksi buy/sell, dan umur pool.

Token DEX/memecoin jauh lebih volatil dan berisiko dibanding pair major di bursa futures — likuiditas bisa sangat tipis, harga gampang dimanipulasi wallet besar, dan pool baru punya risiko rug pull. WAJIB pertimbangkan rasio liquidity/mcap dan umur pool dalam analisa: liquidity yang sangat tipis relatif ke market cap adalah red flag yang harus disebut eksplisit di technical_summary dan bisa jadi alasan menurunkan confidence, bukan diabaikan.

Gabungkan struktur harga (EMA/MACD/Bollinger/Stochastic/ADX) dengan konteks on-chain (liquidity/mcap, volume, rasio buy/sell, umur pool) untuk menentukan arah (BUY/SELL) dan level entry/SL/TP yang realistis relatif terhadap ATR — ATR di token DEX sering besar karena volatilitas tinggi, jangan pasang SL terlalu ketat sampai kena noise normal. ${SIGNAL_JSON_SPEC}`;
}

async function generateDexSignal({ chain, chainLabel, poolAddress, symbol, style = "scalping", context = {}, keyOffset = 0 }) {
  if (!poolAddress) throw new Error("poolAddress wajib diisi.");

  const styleCfg = STYLE_TO_GT[style] || STYLE_TO_GT.scalping;
  const candles = await fetchPoolOhlcv(chain, poolAddress, style, 150);

  if (!candles || candles.length < 30) {
    throw new Error(`Candle DexPaprika untuk pool ini cuma ${candles ? candles.length : 0} — kurang dari minimum 30 buat dianalisa (pool kemungkinan masih terlalu baru).`);
  }

  const ind = computeIndicators(candles);

  const system = buildDexSystemPrompt();
  const userText = `Token: ${symbol} (${chainLabel})
Gaya trading: ${style} (timeframe ${styleCfg.label})

=== INDIKATOR TEKNIKAL (dari candle DexPaprika) ===
${buildIndicatorText(ind)}

=== DATA ON-CHAIN ===
${buildOnChainText({ ...context, chainLabel })}

Buat satu sinyal trading sesuai spesifikasi JSON.`;

  const signal = await callGroq({ system, userText, keyOffset });

  return {
    symbol: String(symbol || "").toUpperCase(),
    chain,
    style,
    timeframe: styleCfg.label,
    price: ind.price,
    indicators: ind,
    signal,
    source: "DexPaprika (candle on-chain) + DexScreener (liquidity/mcap/volume)",
    generated_at: new Date().toISOString(),
  };
}

module.exports = { generateDexSignal };
