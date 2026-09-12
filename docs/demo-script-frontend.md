# Credence — Frontend-Driven Demo Script (record the video from the UI)

Target: a **4-minute** screen-recorded demo driven almost entirely from the
Credence dashboard, ending with a Hedera evidence ledger on screen. Everything
below maps to a real button/panel in the app — no terminal required during the
recording except the two services that must already be running in the
background (backend + x402 server).

---

## The problem (30-second pitch, narrate over the Overview page)

> AI agents are starting to transact autonomously — pay for data, buy
> compute, settle contracts — but there is no credit system for machines. You
> either trust an agent fully or you babysit it, and nobody can safely extend
> credit or working capital to one.
>
> Credence is the trust layer for the machine economy: a portable, on-chain
> FICO score for agents, backed by a real human, enforced by a credit escrow,
> and read by any AI agent over MCP. The same score that decides how much an
> agent can spend also decides how cheaply it can raise working capital — and
> agents pay for that score per call, in HBAR, from their own wallets.

The headline loop you demonstrate in the video:

```
score (CreditBureau → The Graph)
  ├─ gates spending.............. CreditEscrow settlement (Reports/Settlement)
  ├─ prices receivables.......... ATS bond issuance at a discount (Hedera tab)
  ├─ prices the LP market........ compliance-enforced transfer + maturity
  └─ prices credit data.......... agents PAY per report in HBAR via x402
```

---

## Cast of characters

**4 agents**, each with its own Sepolia controller wallet (private key) and a
preminted ENSv2 subname. In prep you register `alpha`/`nova`/`rex` via the
CLI; the video keeps **one live frontend registration** (`zoe`) to show the
mechanism without eating video time:

| ENS name | Role in the demo | Controller wallet | Why |
|---|---|---|---|
| `alpha.trader.agentcreditbureau.eth` | **The star** — Prime borrower | wallet A | 60 clean outcomes → score 880–950, human-backed, 1–3% factoring rate. Pays for its report, factors a $1,000 invoice, sells to the LP. |
| `nova.analyst.agentcreditbureau.eth` | **Mid-tier** marketplace color | wallet B | ~40 clean outcomes → score ~650–799 (Building). Makes `list_agents` ranking look real and shows different agents get different rates. |
| `rex.trader.agentcreditbureau.eth` | **The defaulter** — risk counter-example | wallet C | One default → frozen, spend limit → 0, factoring declined. Proves the system fails closed. |
| `zoe.trader.agentcreditbureau.eth` | **New borrower** — registered LIVE in the video | MetaMask-connected wallet | Starts at score 500 (New) and is the live frontend registration. Proves a fresh agent can be on-boarded in seconds and still pay/borrow. |

**1 liquidity provider (LP)** — a **Hedera testnet account** (`0.0.x`, holds
HBAR + the receivable token). Not an ENS agent; in the UI just enter its
account id in the "Transfer to LP" field. If you want every counterparty
named, register `mercury.lp.agentcreditbureau.eth` (same flow, 10 seconds).

### Wallet/prep amounts
- 4 Sepolia controller wallets (A/B/C for seeding + one MetaMask account for
  the live `zoe` registration): a few test ETH each (Sepolia faucet).
- 1 Hedera testnet operator account (funded; **must have ~5+ HBAR**): used by
  the backend for ATS issuance/transfer/schedule/redeem.
- 1 Hedera x402 payer wallet (the "agent wallet" that pays for reports):
  a fresh `0.0.x` with **1–2 HBAR** (top up at https://portal.hedera.com).
- LP Hedera account: 1 HBAR (to autog-associate the receivable token; ATS is
  whitelist-based so the LP must also be KYC-granted for the transfer to pass
  — see prep).

---

## Pre-recording setup (do this BEFORE hitting record — the video only shows
## the frontend, never this setup)

1. **Hedera credentials — CRITICAL, currently broken in this repo:**
   - The `.env` `HEDERA_OPERATOR_KEY` does **not** match `HEDERA_OPERATOR_ID`
     `0.0.4831992` (verified: derived pubkey ≠ account pubkey). Either
     regenerate the account key in the Hedera portal and update the env, or
     create a fresh funded testnet account and use its id+key.
   - `ATS_FACTORY_ADDRESS` / `ATS_RESOLVER_ADDRESS` are still `0x...`
     placeholders — fill with the Asset Tokenization Studio testnet factory +
     resolver addresses, e.g. from the ATS monorepo deploy artifacts
     (https://github.com/hashgraph/asset-tokenization-studio).
   - Fund the x402 payer wallet (portal.hedera.com) and set
     `X402_PAYER_ACCOUNT`/`X402_PAYER_KEY` in `.env`.
   - Sanity-check with: `curl http://127.0.0.1:8787/api/hedera/status` — all
     four pills on the Hedera tab should read live.
2. **Populate credit history** (offscreen, before recording). The simulator
   drives the agent whose private key is `AGENT_PRIVATE_KEY`, so run it once
   per controller with the matching key and label:
   - Register the three subnames first (skip if you already did via the
     frontend during setup):
     `node backend/integrations/ens/register-single-agent.js alpha <walletA>`
     `node backend/integrations/ens/register-single-agent.js nova <walletB>`
     `node backend/integrations/ens/register-single-agent.js rex <walletC>`
   - Seed history (~2–3 min of tx; reduce `60`→`40` if short on time):
     `cd simulator`
     `SIM_AGENT_LABEL=alpha AGENT_PRIVATE_KEY=<walletA> node simulate-agent.js good 60`
     `SIM_AGENT_LABEL=nova  AGENT_PRIVATE_KEY=<walletB> node simulate-agent.js good 40`
     `SIM_AGENT_LABEL=rex   AGENT_PRIVATE_KEY=<walletC> node simulate-agent.js default 1`
   - Wait for the subgraph to index (check the Graph tools `list_agents`).
   - `zoe` gets NO history — she is registered live in the video and starts
     at score 500 (New), which is exactly the story.
3. **Start the two background services** (leave running during the video):
   - `cd backend && node server.js`
   - `cd backend/integrations/hedera && npm run start:x402`
4. **Pre-open browser tabs** (for cut-aways during the video):
   - Subgraph Studio playground (AgentHistory query for alpha)
   - HashScan account page for the operator
   - Blocky402 helper page (to show the facilitator claim, optional)
5. **KYC-grant the LP** before the transfer step (optional but shows
   compliance control in action): grant the LP's claim in ATS Studio / via the
   SDK so the transfer passes; to SHOW the control, first attempt a transfer
   to a NON-granted address and read the compliance rejection, then transfer
   to the granted LP.

The dashboard's live-config strip and the Hedera tab's four status pills are
your on-screen proof that everything is configured.

---

## The recording sequence (≈4 minutes, all from the frontend)

### 0:00–0:25 — THE PROBLEM + SYSTEM MAP (`Overview`)
- Read the kicker + capability index cards 01→09. Narrate the loop.
- End with: "Let's watch one agent live — from identity to paying its own
  way on Hedera."

### 0:25–0:50 — MINT A NEW AGENT LIVE (`Register agent`)
- MetaMask connected (this wallet = zoe's controller). Type label `zoe` →
  **Register identity** → confirm in wallet.
- On success: read the subname `zoe.trader.agentcreditbureau.eth`, the
  resolver proxy, and the EAC note (CreditBureau scoped to exactly one text
  record — the spend limit).
- One line: "A brand-new agent is on the books in one click, starting at
  score 500 — now let's look at the agent who's been performing."

### 0:50–1:10 — HUMAN BACKING (`Verify World`)
- Verify World tab → **check AgentBook status** for alpha's controller →
  shows human-backed ✓ (or run the Selfie Check for the camera moment).
- One line: "a unique human stands behind this agent — that's the Sybil
  shield baked into the score."

### 1:10–1:40 — THE CREDIT REPORT (`Reports`)
- Enter `alpha.trader.agentcreditbureau.eth` → **Pull report**.
- Point at: score (880+, Prime), spend limit, clean outcome table, sparkline,
  and the analyst decision "approve" with its evidence list.
- Quick contrast: pull `rex.trader.agentcreditbureau.eth` → frozen, 0 limit,
  decision "decline". "Same system, opposite verdict — the score is earned,
  not claimed."

### 1:40–1:55 — THE MARKETPLACE VIEW (`Graph tools`)
- **Run tool: list_agents** → ranking shows alpha at top, nova mid, rex
  bottom, zoe new. **Run tool: get_agent_report** → the exact JSON an AI
  agent receives. "Any agent can pull this over MCP — the same payload is on
  screen."

### 1:55–2:25 — HEDERA: THE AGENT PAYS FOR ITS OWN REPORT (`Hedera payments`)
- Hedera tab. Status pills all live. Enter `alpha.trader.agentcreditbureau.eth`.
- **Pay for report** → watch it return the report + payment tx + HashScan link.
- Narrate: "100 tinybar. The agent's own wallet signed an HBAR transfer;
  Blocky402 verified and settled it; the service delivered the report. No API
  key, no subscription — metered credit data at machine speed."

### 2:25–2:45 — PRICING THE RECEIVABLE (`Hedera payments`)
- **Price receivable** (free oracle) with face $1,000 → 3% → sell price $970.
- **Pay for quote** (50 tinybar) → same price delivered as a paid service.
- "The same score that just sold the report prices the invoice."

### 2:45–3:15 — FACTORING: ISSUE → SELL (`Hedera payments`)
- **Issue receivable** ($1,000, 30 days) → ATS bond created; token address
  autofills; HashScan link.
- **Transfer to LP** with the LP account + units → compliance-enforced
  transfer lands. (Optional freeze-frame: first attempt to an un-granted
  address is rejected.)
- "The invoice is now a tradable, compliance-enforced asset priced off the
  agent's reputation."

### 3:15–3:35 — MATURITY (`Hedera payments`)
- **Schedule settlement** (mode: contract) → Scheduled Transaction id.
- (Optionally **Redeem at maturity** to show the immediate lifecycle op.)
- "Hedera's native scheduled transactions mean the payout happens at maturity
  whether or not anyone is online."

### 3:35–3:50 — THE EVIDENCE LEDGER + CLOSE (`Hedera payments`)
- Scroll the evidence ledger: every action with its HashScan link.
- Cut to HashScan once (e.g., the x402 payment → CRYPTOTRANSFER SUCCESS) and
  to Subgraph Studio for 5 seconds.
- Close: "One score, one ledger. It decides who can be trusted, how much they
  can spend, what their future earnings sell for — and they pay for that
  trust in HBAR, per call. That's credit infrastructure for machines."

### Optional 3:50–4:30 — MCP CHAT (if the track judges love agent tooling)
- Open MCP chat: "pull a credit report for alpha" → backend routes it →
  answer in chat. "This is the same flow an AI agent executes — Credence is
  credit infrastructure agents can actually use."

---

## Failure path (backup segment, or extra-credit cut)
- `rex` (frozen) → factoring "not eligible" everywhere: Reports, quote, and
  the paid x402 rate all fail closed. One sentence: "Risk isn't a checkbox —
  the market refuses frozen agents automatically."

---

## Recording checklist
- [ ] `.env` Hedera key matches the operator account; `ATS_FACTORY_ADDRESS` +
      `ATS_RESOLVER_ADDRESS` filled; x402 payer funded (portal.hedera.com).
- [ ] `curl http://127.0.0.1:8787/api/hedera/status` → operator/ATS/x402/payer
      all live; the Hedera tab's four pills green.
- [ ] Win + macOS screen-recorder settings: 1080p+60fps, click/keystroke
      visualization ON (judges follow the mouse).
- [ ] MetaMask on Sepolia, accounts 1–3 funded with test ETH; LP + payer
      Hedera accounts with HBAR.
- [ ] Simulator ran per controller (alpha/nova/rex); subgraph synced
      (`list_agents` returns ≥4 agents incl. zoe).
- [ ] Subgraph Studio + HashScan + Etherscan tabs pre-opened.

## Evidence bundle to attach to the submission
1. Frontend recording (≤5 min — the sequence above).
2. HashScan links: x402 report payment (CRYPTOTRANSFER SUCCESS), x402 quote
   payment, ATS bond issuance, LP transfer, schedule id (and redeem tx).
3. Etherscan links: `alpha.trader.agentcreditbureau.eth` registration +
   resolver + EAC grant, CreditBureau profile tx, escrow settlements.
4. Subgraph Studio query output for `AgentHistory` (score/history/lastEvents).
5. `curl /api/hedera/status` output (proves live config).
6. README + this doc + repo (public GitHub).

## Troubleshooting
- **"x402 server down" pill** → `cd backend/integrations/hedera && npm run start:x402`.
- **"operator placeholder" pill** → the `HEDERA_OPERATOR_KEY` in `.env` does
  not match `HEDERA_OPERATOR_ID`; fix or create a new funded account.
- **"ATS not configured" pill** → set `ATS_FACTORY_ADDRESS` +
  `ATS_RESOLVER_ADDRESS` (ATS testnet deploy artifacts).
- **Transfer rejected** → LP is not whitelisted/KYC-granted; grant in ATS
  Studio (good demo moment: show the rejection first).
- **Paid report fails INSUFFICIENT_ACCOUNT_BALANCE** → top up the payer at
  https://portal.hedera.com.
- **score shows 0** → re-run the simulator and wait for the subgraph to sync
  (`GRAPH_ENDPOINT` must point at the deployed subgraph).