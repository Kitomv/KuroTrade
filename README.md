# KuroTrade

A self-hosted crypto trading terminal. DexScreener market data, an LLM
multi-agent analysis engine, and swaps executed through MetaMask.

**The backend never holds a private key and never signs a transaction.** It
builds an unsigned 1inch transaction; you approve it in MetaMask. The
autopilot proposes trades — a human still signs every one.

---

## The design decision everything else follows from

Most trading bots fail the same way: they hold your keys, and then a bug, an
exploit, or a leaked `.env` becomes a drained wallet. This project took the
opposite trade-off:

- The backend signs **nothing**. No keystore, no `MASTER_ENCRYPTION_KEY`, no
  encrypted key file. A dump of the server contains no material.
- Every real swap is a human signature in MetaMask. The autopilot decides
  *what* to trade and *why* — not to spend without asking.
- The cost: 24/7 unattended execution is impossible. A bot that never asks is
  a bot that can drain you.

If you want unattended trading, this is deliberately the wrong tool.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Backend | Node 20 + Express 5, ESM | No build step, no transpile |
| Chain | EVM only (Base + 6 more) | One tested path beats two half-tested |
| Swap | 1inch Aggregation API | The API key stays server-side |
| Signing | MetaMask (EIP-1193) | The key never leaves the browser |
| Frontend | React 18 + Vite + TypeScript | ~300 kB bundle, no wallet library |
| Storage | JSON, one file per user | Readable, diffable, trivial to back up |
| Auth | Wallet signature **or** scrypt + Bearer session | No external dependency |

No database, no ORM, no queue, no Docker required. State is one JSON file per
user under `backend/data/`.

---

## Running it

```bash
# 1. Install
npm run install:all

# 2. Configure
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```bash
# Optional — creates a username/password account on boot. Add more accounts by
# changing this and restarting. (You can also just sign in with MetaMask; a
# wallet that has never been seen before gets its own account automatically.)
USER_USERNAME=yourname
USER_PASSWORD=a-long-password

# Required for real swaps — the backend calls 1inch with this key.
# https://portal.1inch.dev
INCH_API_KEY=

# Optional — only needed if you use an LLM provider
ROUTER_API_KEY=
```

Then:

```bash
npm run start-all   # backend :3001 + frontend :5173
```

Open http://localhost:5173.

**Paper trading works with no API keys at all.** Explore the dashboard, run the
agents, and trade the virtual ledger before spending anything.

---

## First run with a real wallet

**Signing in with MetaMask.** The login page has a *Login dengan MetaMask*
button next to the password form. You sign one message; the address recovered
from that signature is the identity, and the account is created on the spot if
that wallet has never been seen. Because the signature already proves the
address is yours, the wallet is bound in the same step — there is no separate
bind to do, and you can trade real immediately.

**Signing in with a password.** If you use the username/password form, nothing
about your wallet is proven yet, so one more step is needed:

1. **Settings → Connect MetaMask.** Requires the extension; the app talks to
   `window.ethereum` directly.
2. **Bind the wallet.** The server issues a single-use, 5-minute nonce and you
   sign a one-line message. Binding proves the address is yours — it moves no
   funds. Replaying a captured signature fails, because the nonce is consumed.
   One wallet can only ever belong to one account.
3. **Enable Real Wallet mode.** The Portfolio page now reads your actual
   on-chain balances instead of the paper ledger.
4. **Trade → create an intent → approve in MetaMask.**

Either way, every real swap still ends in a MetaMask signature.

**Start with a small amount.** Swap routing, slippage, and ERC-20 allowances
are the parts that have not been exercised against live funds.

---

## What the autopilot does

An LLM bull/bear debate scores tokens, a deterministic risk gate vetoes, and
the guardian watches every open position for take-profit and stop-loss.

- The scout emits **intents**; it never executes.
- You approve each one in MetaMask.
- Realized PnL is booked when an intent reaches `done` — an intent you ignore
  is a proposal, not a trade, and is not counted.

The real-wallet branch refuses to size a buy it cannot price. If the native/USD
rate cannot be resolved for your chain, the buy is skipped rather than converted
at another chain's rate. Failing closed is the point.

---

## Chains

Base is the default and best-tested. Also configured: Ethereum, Arbitrum,
BNB Chain, Optimism, Polygon, Avalanche.

**Optimism cannot currently price its native currency.** DexScreener's
`/latest/dex/tokens/{address}` returns a truncated 30-pair set and Optimism's
WETH pair is never in it, so the price resolves to `null` and buys are refused.
Sells and reads still work. The other six chains price fine.

---

## Security notes

Worth knowing if you run this with real money:

- **Passwords are scrypt-hashed** with a per-user salt, migrated from an older
  sha256 scheme on login.
- **Sessions are 14-day bearer tokens** in `backend/data/sessions.json`.
- **Rate limits** are per-IP on login and LLM config, per-user on `/api/real/*`.
- **SSRF guard** on user-supplied LLM base URLs blocks cloud metadata endpoints
  and private ranges.
- **The swap router is allow-listed.** 1inch's v6 router is CREATE2-deployed at
  the same address on every chain
  (`0x111111125421cA6dc452d289314280A0F8842A65`). The frontend refuses to sign
  anything aimed elsewhere, and ERC-20 approvals are granted for the **exact
  swap amount** — never `MaxUint256`. Override with `ONE_INCH_ROUTER` if 1inch
  rotates it.
- **CSV exports are formula-injection safe** (leading `= + - @` are prefixed).
- **Never trade over plain http or a tunnel.** The app warns; signing on an
  untrusted origin is a real risk.

`backend/.env` and `backend/data/` are gitignored — they hold your secrets and
every user's account. Back them up separately and never commit them.

---

## Tests

```bash
npm --prefix backend test
```

117 tests. The ones that matter most cover the money path: intent state
transitions, claim-token races, idempotent close, bind replay rejection, the
router allow-list, wallet-login challenge replay, and the SSRF guard.

```bash
npm --prefix frontend run build   # tsc -b && vite build
```

---

## Project layout

```
backend/src/
  server.js         routes, rate limits, auth guard
  aiAgent.js        autopilot: scan, debate, guardian, PnL
  realIntent.js     intent state machine (open → active → done)
  evmWallet.js      1inch quote + unsigned tx builder, 7 chains
  evmBind.js        EIP-191 signature verification
  wallet.js         virtual paper-trading ledger
  persistence.js    atomic per-user JSON writes
  dexscreener.js    market data client with per-chain caching

frontend/src/
  components/EvmWalletContext.tsx   MetaMask connection + approve flow
  lib/evm.ts                        EIP-1193 helpers
  pages/Agents.tsx                  autopilot terminal
  pages/Portfolio.tsx               positions and PnL
  styles.css                        the whole design system
```

---

## License

MIT — see [LICENSE](LICENSE).
