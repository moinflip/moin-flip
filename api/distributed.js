// Exact SOL paid to moin holders.
// Every SOL that enters the distributor wallet comes from moin's creator vault, and the
// distributor only pays holders, so: paid out = everything sent in - what it still holds.
// The running "sent in" total is stored in Firestore so each call only reads new transactions.
const { CREATOR_VAULT, DISTRIBUTOR, rpc, adminDb, sleep } = require('../lib/solana');

const PER_CALL = 60; // max new transactions processed per request (the first backfill spreads over a few calls)

async function signaturesSince(until) {
  const out = [];
  let before;
  for (let i = 0; i < 50; i++) {
    const opt = { limit: 1000 };
    if (before) opt.before = before;
    if (until) opt.until = until;
    const r = await rpc('getSignaturesForAddress', [CREATOR_VAULT, opt]);
    out.push(...r);
    if (r.length < 1000) break;
    before = r[r.length - 1].signature;
  }
  return out.reverse(); // oldest first
}

// SOL the distributor gained in a transaction where the creator vault lost SOL.
// Uses balance changes, so it works whether the program moved SOL with a system
// transfer or by editing lamports directly.
function lamportsIntoDistributor(tx) {
  const keys = (tx.transaction.message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const v = keys.indexOf(CREATOR_VAULT), d = keys.indexOf(DISTRIBUTOR);
  if (v < 0 || d < 0 || !tx.meta) return 0;
  const dv = tx.meta.postBalances[v] - tx.meta.preBalances[v];
  const dd = tx.meta.postBalances[d] - tx.meta.preBalances[d];
  return dv < 0 && dd > 0 ? dd : 0;
}

module.exports = async (req, res) => {
  try {
    const db = adminDb();
    const ref = db.doc('meta/distributed_v2');
    const snap = await ref.get();
    const st = snap.exists ? snap.data() : { inLamports: 0, newest: null, sweeps: 0, lastSweep: null };

    const sigs = await signaturesSince(st.newest || undefined);
    const batch = sigs.slice(0, PER_CALL);
    let add = 0, sweeps = 0, lastSweep = st.lastSweep || null, processed = 0;

    for (let i = 0; i < batch.length; i += 4) {
      if (i) await sleep(250); // stay under the free plan's requests-per-second limit
      const chunk = batch.slice(i, i + 4);
      const txs = await Promise.all(chunk.map((s) => s.err ? null :
        rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }])));
      let stop = false;
      for (let k = 0; k < chunk.length; k++) {
        if (!chunk[k].err && !txs[k]) { stop = true; break; } // not available yet; pick it up next call
        if (txs[k]) {
          const v = lamportsIntoDistributor(txs[k]);
          if (v > 0) { add += v; sweeps++; lastSweep = (txs[k].blockTime || 0) * 1000; }
        }
        processed++;
      }
      if (stop) break;
    }

    let state = st;
    if (processed > 0) {
      const newest = batch[processed - 1].signature;
      await db.runTransaction(async (t) => {
        const cur = await t.get(ref);
        const c = cur.exists ? cur.data() : { inLamports: 0, newest: null, sweeps: 0 };
        if ((c.newest || null) !== (st.newest || null)) { state = c; return; } // another request already saved this range
        state = {
          inLamports: (c.inLamports || 0) + add,
          newest,
          sweeps: (c.sweeps || 0) + sweeps,
          lastSweep: lastSweep || c.lastSweep || null,
          updated: Date.now(),
        };
        t.set(ref, state);
      });
    }

    const bal = await rpc('getBalance', [DISTRIBUTOR]);
    const pendingLamports = bal.value;
    const syncing = sigs.length > processed;
    res.setHeader('Cache-Control', syncing ? 'no-store' : 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({
      distributedSol: Math.max(0, ((state.inLamports || 0) - pendingLamports) / 1e9),
      receivedSol: (state.inLamports || 0) / 1e9,
      pendingSol: pendingLamports / 1e9,
      sweeps: state.sweeps || 0,
      lastSweep: state.lastSweep || null,
      syncing,
      updated: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
