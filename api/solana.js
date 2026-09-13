// api/solana.js (Vercel Serverless Function)
// Scan token-token BARU/rame di chain Solana lewat DexScreener public API —
// sama persis pipeline-nya kayak scan.js (Robinhood Chain), cuma beda chain
// & seed query/exclude list yang disesuaikan buat ekosistem Solana
// (pump.fun, Raydium, dst). Logika scan ada di lib/dexscreenerScan.js.
const { scanChain } = require("./lib/dexscreenerScan");

const CHAIN_ID = "solana";
// Quote token paling umum dipakai buat pair di Solana (SOL/wSOL, stablecoin)
const SEED_QUERIES = ["SOL", "USDC", "USDT"];
// Token mayor/quote yang dibuang kalau nongol sebagai base token — ini
// infrastruktur/stablecoin, bukan meme coin barunya.
const EXCLUDE_AS_BASE = new Set(["SOL", "WSOL", "USDC", "USDT", "USDH", "JITOSOL", "MSOL"]);

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
