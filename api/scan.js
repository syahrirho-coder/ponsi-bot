// api/scan.js (Vercel Serverless Function)
// Scan token-token BARU di Robinhood Chain lewat DexScreener public API.
// Logika scan-nya ada di lib/dexscreenerScan.js (dipakai bareng sama
// solana.js) — file ini cuma nyetel konfigurasi khusus chain Robinhood.
const { scanChain } = require("./lib/dexscreenerScan");

const CHAIN_ID = "robinhood";
// Dipakai cuma sebagai QUOTE token buat menjaring pair (bukan buat jadi "token" itu sendiri)
const SEED_QUERIES = ["WETH", "USDG", "ETH"];
// Token mayor/quote yang HARUS dibuang kalau nongol sebagai base token —
// ini bukan meme coin, cuma kepasang di hasil search karena namanya cocok sama query.
const EXCLUDE_AS_BASE = new Set(["WETH", "WBTC", "USDG", "USDC", "USDT", "DAI", "ETH", "ROBINHOOD", "HOOD"]);

module.exports = async function handler(req, res) {
  try {
    const tab = (req.query && req.query.tab) || "trending";
    const result = await scanChain({ chainId: CHAIN_ID, seedQueries: SEED_QUERIES, excludeAsBase: EXCLUDE_AS_BASE, tab });
    res.setHeader("Cache-Control", "public, max-age=10");
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "scan_failed", message: String((err && err.message) || err) });
  }
};
