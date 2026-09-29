// Top 100 holders, aggregated by wallet. Cached at the edge for 5 minutes to save Helius credits.
const { MINT, POOL, CREATOR_VAULT, DISTRIBUTOR, rpc } = require('../lib/solana');

const LABELS = {
  [POOL]: 'Pump AMM pool',
  [CREATOR_VAULT]: 'Creator vault',
  [DISTRIBUTOR]: 'Rewards distributor',
};

module.exports = async (req, res) => {
  try {
    const owners = new Map();
    for (let page = 1; page <= 25; page++) {
      const r = await rpc('getTokenAccounts', { mint: MINT, page, limit: 1000, options: { showZeroBalance: false } });
      const list = (r && r.token_accounts) || [];
      for (const a of list) {
        const amt = Number(a.amount);
        if (amt > 0) owners.set(a.owner, (owners.get(a.owner) || 0) + amt);
      }
      if (list.length < 1000) break;
    }
    const sup = await rpc('getTokenSupply', [MINT]);
    const dec = sup.value.decimals;
    const supply = Number(sup.value.amount);
    const top = [...owners.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([owner, amt], i) => ({
        rank: i + 1,
        owner,
        amount: amt / 10 ** dec,
        pct: (amt / supply) * 100,
        label: LABELS[owner] || null,
      }));
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ holders: owners.size, supply: supply / 10 ** dec, top, updated: Date.now() });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
