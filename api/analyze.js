// api/analyze.js (Vercel Serverless Function)
// Endpoint buat tombol "Analisa" di 1 baris pair Binance Futures — sengaja
// TERPISAH dari binance-futures.js (yang scan semua pair tiap 15 detik) supaya
// pipeline berat (indikator penuh + Groq AI) cuma jalan pas user benar-benar
// klik pair yang diminatin, bukan buat ratusan pair sekaligus tiap refresh.
const { generateSignal } = require("./lib/generate");
const { parseBody } = require("./lib/http");

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

  if (!body.symbol) {
    return res.status(400).json({ error: "symbol_required" });
  }

  try {
    const result = await generateSignal({
      symbol: body.symbol,
      style: (body.style || "scalping").toLowerCase(),
      keyOffset: Number(body.keyOffset) || 0,
    });
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "analyze_failed", message: String((err && err.message) || err) });
  }
};
