// Shared helpers for the serverless API routes.
const MINT = '8DXqVUopcdviLvujTcpwEqkKzB43Arp6E1axzsEE5Btq';
const POOL = 'CbR2UL7ktBr8MUUTj3FYcURZerp28GA2p1vPuMeKy1Je'; // Pump AMM moin/SOL pool
const CREATOR_VAULT = '3r1CYXAGNwjJe5nDwYPdVetWhyCFKXx489YGj5sYY17Z'; // sweeps fees into the distributor
const DISTRIBUTOR = '6Xp6WiRPj3LgEAVyt7ErYaGc2HqX9WAvAMmcNgeeBWVa'; // pays SOL rewards to holders

function rpcUrl() {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY is not set in Vercel environment variables');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function rpc(method, params) {
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'moin', method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}


// Tolerates stray text or a key pasted twice: pulls out every complete {...} object
// and uses the last one that looks like a service account.
function parseServiceAccount(raw) {
  const text = String(raw).trim();
  try { return JSON.parse(text); } catch (e) { /* fall through */ }
  const found = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0) { try { found.push(JSON.parse(text.slice(start, i + 1))); } catch (e) {} } }
  }
  const sa = found.filter((o) => o && o.private_key && o.client_email).pop();
  if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT is not a valid service-account JSON');
  return sa;
}

let _db = null;
function adminDb() {
  if (_db) return _db;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel environment variables');
    admin.initializeApp({ credential: admin.credential.cert(parseServiceAccount(raw)) });
  }
  _db = admin.firestore();
  return _db;
}

module.exports = { MINT, POOL, CREATOR_VAULT, DISTRIBUTOR, rpc, adminDb };
