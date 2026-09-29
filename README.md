# Moin Flip

Coin-flip game, live chat, leaderboard and MC chart for $MOIN, plus live on-chain data:
top 100 holders, live trades, and exact SOL paid to holders.

## What's in here

| File | What it does |
|---|---|
| `index.html` | The whole site |
| `firebase-config.js` | Your Firebase web-app config (already filled in) |
| `firestore.rules` | Database security rules (paste into Firebase) |
| `api/holders.js` | Top 100 holders (Helius, cached 5 min) |
| `api/trades.js` | Live trades + price/MC/volume (GeckoTerminal, free) |
| `api/distributed.js` | Exact SOL paid to holders (Helius + Firestore) |
| `lib/solana.js` | Addresses and shared helpers |

## Setup

### 1. Firebase (project `moinflip-1b165`)
1. **Authentication → Get started → Sign-in method → Anonymous → Enable → Save.**
2. **Firestore Database → Rules** → replace everything with the contents of `firestore.rules` → **Publish**.
3. **Project settings (gear) → General → Your apps → Web (`</>`)** → nickname `moinflip` → **Register app**.
   Copy the `apiKey`, `messagingSenderId` and `appId` values into `firebase-config.js`
   (also check `storageBucket` matches what Firebase shows).
4. **Project settings → Service accounts → Generate new private key.** A `.json` file downloads.
   Keep it private. You'll paste its contents into Vercel in step 3.

### 2. GitHub
Create a new repository (e.g. `moinflip`), then **Add file → Upload files** and drag in
everything from this folder (keep the `api` and `lib` folders). Commit.

### 3. Vercel
1. **Add New → Project → Import** your `moinflip` repo. Framework preset: **Other**.
2. Before deploying, open **Environment Variables** and add:
   - `HELIUS_API_KEY` → your key from dashboard.helius.dev → API Keys
   - `FIREBASE_SERVICE_ACCOUNT` → the entire contents of the service-account `.json` file
3. **Deploy.** Your site is live at `https://<project>.vercel.app`.

The first time someone opens the site, the "SOL paid to holders" panel shows *Syncing history…*
for a few seconds while it reads the rewards wallet's past payouts. After that it only reads new ones.

## How "SOL paid to holders" is calculated
Every moin trade pays a creator fee into moin's Pump AMM creator vault. The vault
(`3r1CYXAGNwjJe5nDwYPdVetWhyCFKXx489YGj5sYY17Z`) sweeps it every ~15–30 min to the rewards
wallet `6Xp6WiRPj3LgEAVyt7ErYaGc2HqX9WAvAMmcNgeeBWVa`, which only pays holders.
Paid to holders = everything the vault has sent that wallet − what the wallet still holds.

## Helius free-plan usage (approx.)
Holders ~350k credits/month, distributions ~130k/month. Trades use GeckoTerminal (no credits).
That leaves headroom under the 1M free credits. Edge caching means visitor count barely changes this.
