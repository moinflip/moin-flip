// Live trades + pool stats from GeckoTerminal's free public API (no Helius credits used).
const { POOL } = require('../lib/solana');
const GT = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${POOL}`;

module.exports = async (req, res) => {
  try {
    const h = { accept: 'application/json' };
    const get = async (url) => {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(url, { headers: h });
        if (r.ok) return r.json();
        await new Promise((ok) => setTimeout(ok, 700 * (i + 1))); // GeckoTerminal rate limit: back off and retry
      }
      return null;
    };
    const [p, t] = await Promise.all([get(GT), get(`${GT}/trades`)]);
    if (!p || !t || !t.data) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(502).json({ error: 'GeckoTerminal is busy, try again shortly' });
    }
    const a = (p && p.data && p.data.attributes) || {};
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const pool = {
      priceUsd: num(a.base_token_price_usd),
      mcUsd: num(a.market_cap_usd) || num(a.fdv_usd),
      vol24: num(a.volume_usd && a.volume_usd.h24),
      change24: num(a.price_change_percentage && a.price_change_percentage.h24),
      solUsd: num(a.quote_token_price_usd),
    };
    const trades = ((t && t.data) || []).slice(0, 50).map((x) => {
      const b = x.attributes;
      const buy = b.kind === 'buy';
      return {
        sig: b.tx_hash,
        t: Date.parse(b.block_timestamp),
        side: buy ? 'buy' : 'sell',
        sol: Number(buy ? b.from_token_amount : b.to_token_amount),
        moin: Number(buy ? b.to_token_amount : b.from_token_amount),
        usd: Number(b.volume_in_usd),
        trader: b.tx_from_address,
      };
    });
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json({ pool, trades, updated: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
