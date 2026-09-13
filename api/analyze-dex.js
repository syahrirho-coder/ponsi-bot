// api/analyze-dex.js (Vercel Serverless Function)
// Endpoint buat tombol "Analisa" di tabel token DEX (Robinhood Chain /
// Solana) — paralel sama analyze.js (Binance Futures), tapi pipeline
// datanya beda (lihat lib/generateDex.js).
const { generateDexSignal } = require("./lib/generateDex");
const { parseBody } = require("./lib/http");

const CHAIN_LABELS = {
  robinhood: "Robinhood Chain",
  solana: "Solana",
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  let body;
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ error: "invalid_json" });
  }

  const chain = (body.chain || "").toLowerCase();
  if (!chain || !CHAIN_LABELS[chain]) {
    return res.status(400).json({ error: "chain_required", message: "chain harus 'robinhood' atau 'solana'." });
  }
  if (!body.poolAddress) {
    return res.status(400).json({ error: "poolAddress_required" });
  }

  try {
    const result = await generateDexSignal({
      chain,
      chainLabel: CHAIN_LABELS[chain],
      poolAddress: body.poolAddress,
      symbol: body.symbol,
      style: (body.style || "scalping").toLowerCase(),
      context: body.context || {},
      keyOffset: Number(body.keyOffset) || 0,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "analyze_dex_failed", message: String((err && err.message) || err) });
  }
};
