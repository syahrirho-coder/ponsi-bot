// lib/generate.js
// Analisa mendalam ON-DEMAND untuk 1 pair Binance Futures — dipanggil pas
// user klik tombol "Analisa" di satu baris tabel, BUKAN buat semua pair
// sekaligus (makanya gak dipanggil dari binance.js/scan.js).
//
// Pipeline: candle diambil LANGSUNG dari Binance Futures (Bybit dimatiin
// total karena kebukti 403 dari infra Netlify — lihat komentar di
// marketdata.js), indikator dihitung penuh (lib/indicators.js), digabung
// sama data komposit lintas exchange (lib/marketdata.js — funding/OI/
// long-short/orderbook Binance + funding/OI/orderbook/long-short OKX),
// terus sinyal BUY/SELL + entry/SL/TP dibuat lewat Groq AI (lib/groq.js).
const { computeIndicators } = require("./indicators");
const {
  fetchCompositeData,
  toBinanceFuturesSymbol,
  fetchFuturesKlines,
} = require("./marketdata");
const { callGroq, SIGNAL_JSON_SPEC } = require("./groq");

const STYLE_INTERVALS = {
  m1: { outputsize: 150, label: "M1" },
  m5: { outputsize: 150, label: "M5" },
  m30: { outputsize: 150, label: "M30" },
  scalping: { outputsize: 150, label: "M15" },
  daytrade: { outputsize: 150, label: "H1" },
  swing: { outputsize: 150, label: "H4" },
};

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
    `VWAP: ${ind.vwap ? fmt(ind.vwap) : "n/a (data volume tidak tersedia dari sumber harga)"}`,
    `Jumlah candle dianalisa: ${ind.candleCount}`,
  ];
  return lines.join("\n");
}

function buildCompositeText(composite) {
  if (!composite) return "Data komposit (funding rate/OI/long-short/orderbook/dominasi BTC): tidak diambil.";
  const lines = [];

  lines.push("--- Binance Futures ---");
  lines.push(
    composite.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.funding.fundingRate, 4)}% — ${composite.funding.fundingRate > 0 ? "long membayar short (bias crowd long)" : "short membayar long (bias crowd short)"}`
      : "Funding Rate: n/a"
  );
  lines.push(
    composite.openInterest
      ? `Open Interest: ${composite.openInterest.openInterest.toLocaleString("en-US")} kontrak`
      : "Open Interest: n/a"
  );
  lines.push(
    composite.longShort
      ? `Long/Short Account Ratio (1h, akun retail): ${fmt(composite.longShort.longShortRatio, 2)} (long ${fmt(composite.longShort.longAccount, 1)}% vs short ${fmt(composite.longShort.shortAccount, 1)}%)`
      : "Long/Short Ratio: n/a"
  );
  lines.push(
    composite.orderbook
      ? `Orderbook Imbalance (top 50 level): ${fmt(composite.orderbook.imbalancePct, 1)}% ${composite.orderbook.imbalancePct > 0 ? "condong ke sisi beli (bid)" : "condong ke sisi jual (ask)"}`
      : "Orderbook Imbalance: n/a"
  );

  lines.push("--- Bybit ---");
  lines.push(
    composite.bybit?.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.bybit.funding.fundingRate, 4)}%`
      : "Funding Rate: n/a"
  );
  lines.push(
    composite.bybit?.longShort
      ? `Long/Short Account Ratio (1h): ${fmt(composite.bybit.longShort.longShortRatio, 2)}`
      : "Long/Short Ratio: n/a"
  );
  lines.push(
    composite.bybit?.orderbook
      ? `Orderbook Imbalance: ${fmt(composite.bybit.orderbook.imbalancePct, 1)}%`
      : "Orderbook Imbalance: n/a"
  );

  lines.push("--- OKX ---");
  lines.push(
    composite.okx?.funding
      ? `Funding Rate (per 8 jam): ${fmt(composite.okx.funding.fundingRate, 4)}%`
      : "Funding Rate: n/a"
  );
  lines.push(
    composite.okx?.longShort
      ? `Long/Short Account Ratio (1h): ${fmt(composite.okx.longShort.longShortRatio, 2)}`
      : "Long/Short Ratio: n/a"
  );

  lines.push("--- Lainnya ---");
  lines.push(
    composite.dominance ? `BTC Dominance: ${fmt(composite.dominance.btcDominance, 1)}%` : "BTC Dominance: n/a"
  );

  lines.push("--- Estimasi Tekanan Liquidation ---");
  if (composite.liquidation) {
    const liq = composite.liquidation;
    const biasText =
      liq.bias === "long_liq"
        ? "indikasi LONG LIQUIDATION (posisi long dipaksa tutup, menekan harga turun)"
        : liq.bias === "short_liq"
        ? "indikasi SHORT LIQUIDATION (posisi short dipaksa tutup/short squeeze, menekan harga naik)"
        : "netral, tidak ada tanda flush liquidation signifikan";
    lines.push(
      `Window ${liq.windowMinutes} menit terakhir: perubahan Open Interest ${fmt(liq.oiChangePct, 2)}%, perubahan harga ${fmt(liq.priceChangePct, 2)}%, bias: ${biasText}.`
    );
    lines.push("Catatan: ini ESTIMASI dari perubahan Open Interest + harga, BUKAN data liquidation order asli.");
  } else {
    lines.push("Estimasi Liquidation: n/a");
  }

  lines.push("--- Berita Terbaru ---");
  if (composite.news && Array.isArray(composite.news.articles) && composite.news.articles.length > 0) {
    composite.news.articles.forEach((a, i) => {
      const age = a.ageMinutes !== null && a.ageMinutes !== undefined ? `${a.ageMinutes} menit lalu` : "waktu n/a";
      const tag = a.highImpact ? " [BERITA BESAR]" : "";
      lines.push(`${i + 1}. [${a.source}, ${age}]${tag} ${a.title}`);
    });
  } else if (composite.news) {
    lines.push("Tidak ada berita spesifik untuk koin ini dalam waktu dekat.");
  } else {
    lines.push("Berita: n/a (feed berita gagal diambil)");
  }

  lines.push("--- Momentum & Katalis Berita ---");
  if (composite.momentum) {
    const mom = composite.momentum;
    lines.push(`Perubahan harga: 5 menit ${fmt(mom.m5, 2)}%, 15 menit ${fmt(mom.m15, 2)}%, 1 jam ${fmt(mom.h1, 2)}%.`);
    lines.push(mom.burst ? "Status: sedang terjadi BURST MOMENTUM (>1.5% dalam 15 menit terakhir)." : "Status: pergerakan harga normal, tidak ada burst momentum.");
    if (mom.majorNewsWindow) {
      const mnw = mom.majorNewsWindow;
      lines.push(
        `Berita besar terdeteksi ${mnw.ageMinutes} menit lalu: "${mnw.article}". ${mnw.coincidesWithBurst ? "Ini BERBARENGAN dengan burst momentum di atas — kemungkinan besar katalis pergerakan saat ini." : "Harga belum menunjukkan burst yang jelas sejak berita ini."}`
      );
    }
  } else {
    lines.push("Momentum multi-timeframe: n/a");
  }

  return lines.join("\n");
}

function buildSystemPrompt() {
  return `Kamu adalah mesin analisa teknikal trading untuk fitur "Analisa" di PONSI BOT. Kamu diberi data indikator teknikal DAN data komposit lintas exchange (Binance Futures, Bybit, OKX: funding rate, open interest, long/short ratio, orderbook imbalance, plus BTC dominance dari CoinGecko), estimasi tekanan liquidation, berita terbaru, serta momentum harga multi-timeframe — semua SUDAH dihitung/diambil dari sumber live — jangan mengarang angka baru, dan jangan menyebut data yang ditandai "n/a". Perhatikan juga apakah funding rate/positioning antar exchange searah atau berbeda (misal Binance long-heavy tapi OKX short-heavy) karena itu bisa jadi sinyal penting.

Untuk liquidation: bias "long_liq"/"short_liq" adalah ESTIMASI dari perubahan Open Interest + harga (bukan data liquidation order asli), pakai sebagai konfirmasi tambahan arah tekanan pasar saat ini, jangan sebut angka dolar liquidation.

Untuk berita dan momentum: kalau ada berita yang ditandai [BERITA BESAR] yang baru terjadi DAN "Status" menunjukkan burst momentum yang sejalan dengan arah berita itu, anggap itu katalis utama pergerakan saat ini dan beri bobot besar pada arah tersebut untuk entry. Kalau ada berita besar tapi harga BELUM bereaksi, jangan buru-buru asumsikan arah — jelaskan di reasoning bahwa pasar belum pricing-in berita tersebut. Kalau tidak ada berita besar dan tidak ada burst momentum, andalkan struktur teknikal + positioning seperti biasa.

Gabungkan struktur harga (EMA/MACD/Bollinger/Stochastic/ADX) dengan konteks positioning (funding/long-short/orderbook/dominance), liquidation, dan momentum/berita di atas untuk menentukan arah (BUY/SELL) dan level entry/SL/TP yang realistis relatif terhadap ATR. ${SIGNAL_JSON_SPEC}`;
}

async function generateSignal({ symbol: rawSymbol, style = "scalping", keyOffset = 0 }) {
  const symbol = toBinanceFuturesSymbol(rawSymbol);
  const styleCfg = STYLE_INTERVALS[style] || STYLE_INTERVALS.scalping;

  const [candles, composite] = await Promise.all([
    fetchFuturesKlines(symbol, style, styleCfg.outputsize),
    fetchCompositeData(symbol),
  ]);

  if (!candles || candles.length < 30) {
    throw new Error(`Data candle Binance Futures untuk ${symbol} tidak cukup.`);
  }

  const ind = computeIndicators(candles);

  const system = buildSystemPrompt();
  const userText = `Instrumen: ${symbol} (Binance Futures Perpetual)
Gaya trading: ${style} (timeframe ${styleCfg.label})

=== INDIKATOR TEKNIKAL ===
${buildIndicatorText(ind)}

=== DATA KOMPOSIT ===
${buildCompositeText(composite)}

Buat satu sinyal trading sesuai spesifikasi JSON.`;

  const signal = await callGroq({ system, userText, keyOffset });

  return {
    symbol: String(rawSymbol || "").trim().toUpperCase() || symbol,
    binance_symbol: symbol,
    style,
    timeframe: styleCfg.label,
    price: ind.price,
    indicators: ind,
    composite,
    signal,
    source: "Binance Futures (candle + composite) + OKX (composite) + CoinGecko",
    generated_at: new Date().toISOString(),
  };
}

module.exports = { generateSignal };
