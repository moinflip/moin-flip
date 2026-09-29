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

let _db = null;
function adminDb() {
  if (_db) return _db;
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set in Vercel environment variables');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
  _db = admin.firestore();
  return _db;
}

module.exports = { MINT, POOL, CREATOR_VAULT, DISTRIBUTOR, rpc, adminDb };
