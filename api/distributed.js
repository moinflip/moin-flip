// Exact SOL paid to moin holders.
// Every SOL that enters the rewards wallet (DISTRIBUTOR) comes from moin's creator vault, and the
// rewards wallet only pays holders, so: paid out = everything the vault sent it - what it still holds.
//
// Sync strategy (keeps Helius usage tiny):
//  1. Find when the rewards wallet first appeared (scan its signature list once, 1 credit per 1000).
//  2. Walk the creator vault's history backward from "now" to that moment, reading only those
//     transactions, and add up what moved from the vault into the rewards wallet.
//  3. After that, each request only reads the vault's new transactions.
// Progress is saved in Firestore (meta/distributed_v4) so work is never repeated.
const { CREATOR_VAULT, DISTRIBUTOR, rpc, adminDb, sleep } = require('../lib/solana');

const TX_BUDGET = 100;      // max transactions read per request
const SIG_PAGES = 25;       // max signature pages (1000 each) scanned per request

// SOL the creator vault sent to the rewards wallet in a transaction.
// Prefers the actual transfer instructions; falls back to the rewards wallet's balance
// change (vault fees are often collected and forwarded in the same transaction, so the
// vault's own balance may not move at all).
function lamportsIntoDistributor(tx) {
  let viaIx = 0;
  const scan = (list) => {
    for (const ins of list || []) {
      const p = ins.parsed;
      if (ins.program === 'system' && p && p.type === 'transfer' &&
          p.info.source === CREATOR_VAULT && p.info.destination === DISTRIBUTOR) viaIx += Number(p.info.lamports);
    }
  };
  scan(tx.transaction.message.instructions);
  for (const inner of (tx.meta && tx.meta.innerInstructions) || []) scan(inner.instructions);
  if (viaIx > 0) return viaIx;
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const v = keys.indexOf(CREATOR_VAULT), d = keys.indexOf(DISTRIBUTOR);
  if (v < 0 || d < 0 || !tx.meta) return 0;
  const dd = tx.meta.postBalances[d] - tx.meta.preBalances[d];
  return dd > 0 ? dd : 0;
}

const sigs = (address, opt) => rpc('getSignaturesForAddress', [address, { limit: 1000, ...opt }]);
const getTx = (sig) => rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);

module.exports = async (req, res) => {
  try {
    const db = adminDb();
    const ref = db.doc('meta/distributed_v4');
    const snap = await ref.get();
    const st = snap.exists ? snap.data() : { rev: 0, inLamports: 0, sweeps: 0, lastSweep: null };
    const s = { ...st };
    let budget = TX_BUDGET;

    const addTx = (tx) => {
      const v = lamportsIntoDistributor(tx);
      if (v > 0) {
        s.inLamports = (s.inLamports || 0) + v;
        s.sweeps = (s.sweeps || 0) + 1;
        const t = (tx.blockTime || 0) * 1000;
        if (!s.lastSweep || t > s.lastSweep) s.lastSweep = t;
      }
    };
    // Reads a list of signatures (in the given order) until the budget runs out.
    // Returns how many were fully handled.
    const readList = async (list) => {
      let done = 0;
      for (let i = 0; i < list.length && budget > 0; i += 4) {
        const chunk = list.slice(i, Math.min(i + 4, i + budget));
        if (i) await sleep(250); // stay under the free plan's requests-per-second limit
        const txs = await Promise.all(chunk.map((x) => (x.err ? null : getTx(x.signature))));
        for (let k = 0; k < chunk.length; k++) {
          if (!chunk[k].err && !txs[k]) return done; // not finalized yet; retry next time
          if (txs[k]) addTx(txs[k]);
          budget--; done++;
        }
      }
      return done;
    };

    // Step 1: when did the rewards wallet first appear?
    if (!s.distStart) {
      for (let p = 0; p < SIG_PAGES; p++) {
        const page = await sigs(DISTRIBUTOR, s.distCursor ? { before: s.distCursor } : {});
        if (page.length) s.distCursor = page[page.length - 1].signature;
        if (page.length < 1000) {
          const first = page.length ? page[page.length - 1] : null;
          s.distStart = first && first.blockTime ? first.blockTime : 1; // seconds
          break;
        }
      }
    }

    // Anchor point: the vault's newest transaction when syncing began.
    if (!s.newest) {
      const top = await sigs(CREATOR_VAULT, { limit: 1 });
      if (top.length) { s.newest = top[0].signature; s.backCursor = null; s.backfillDone = false; s.anchorIncluded = false; }
    }

    // Step 3 (cheap, every request): new vault transactions since the anchor/newest.
    if (s.newest) {
      const fresh = [];
      let before;
      for (let p = 0; p < SIG_PAGES; p++) {
        const page = await sigs(CREATOR_VAULT, before ? { until: s.newest, before } : { until: s.newest });
        fresh.push(...page);
        if (page.length < 1000) break;
        before = page[page.length - 1].signature;
      }
      fresh.reverse(); // oldest first
      const n = await readList(fresh);
      if (n > 0) s.newest = fresh[n - 1].signature;
    }

    // Step 2: backfill from the anchor back to when the rewards wallet appeared.
    if (s.distStart && s.newest && !s.backfillDone && budget > 0) {
      if (!s.anchorIncluded) {
        // the anchor signature itself hasn't been read yet
        const anchor = s.backCursor || s.anchorSig || s.newest;
        s.anchorSig = anchor;
        const tx = await getTx(anchor);
        if (tx) { addTx(tx); budget--; s.anchorIncluded = true; s.backCursor = anchor; }
      }
      while (s.anchorIncluded && budget > 0 && !s.backfillDone) {
        const page = await sigs(CREATOR_VAULT, { before: s.backCursor });
        const inRange = [];
        let reachedStart = page.length < 1000;
        for (const x of page) {
          if (x.blockTime && x.blockTime < s.distStart) { reachedStart = true; break; }
          inRange.push(x);
        }
        const n = await readList(inRange);
        if (n > 0) s.backCursor = inRange[n - 1].signature;
        if (n < inRange.length) break;          // budget used up; continue next request
        if (reachedStart) { s.backfillDone = true; break; }
      }
    }

    // Save progress (skip if another request saved first; it will have done the same work).
    if (JSON.stringify(s) !== JSON.stringify(st)) {
      s.rev = (st.rev || 0) + 1;
      s.updated = Date.now();
      await db.runTransaction(async (t) => {
        const cur = await t.get(ref);
        if ((cur.exists ? cur.data().rev || 0 : 0) !== (st.rev || 0)) return;
        t.set(ref, s);
      });
    }

    const bal = await rpc('getBalance', [DISTRIBUTOR]);
    const pendingLamports = bal.value;
    const syncing = !s.backfillDone;
    res.setHeader('Cache-Control', syncing ? 'no-store' : 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      distributedSol: Math.max(0, ((s.inLamports || 0) - pendingLamports) / 1e9),
      receivedSol: (s.inLamports || 0) / 1e9,
      pendingSol: pendingLamports / 1e9,
      sweeps: s.sweeps || 0,
      lastSweep: s.lastSweep || null,
      syncing,
      updated: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
