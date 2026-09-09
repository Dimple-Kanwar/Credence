# Recipe 02 — Underwrite an agent, then factor its receivable (The Graph + Hedera ATS)

The "real jobs rarely fit inside one API call" recipe: a combined workflow
neither sponsor API completes alone.

**APIs used (both ETHOnline 2026 sponsors):**
1. **The Graph** — Credence credit-report subgraph: live agent score,
   history, risk recommendation.
2. **Hedera Asset Tokenization Studio (ATS)** — tokenize the receivable
   (the invoice the agent is owed) as a tradable security sold to a
   liquidity provider at the score-priced discount.

## When to use

- You are a **liquidity provider / factoring desk** and an agent wants to
  sell you a $1,000 invoice for payment on day 0.
- You are an **agent treasury** deciding whether to factor an outstanding
  invoice instead of waiting for maturity — the workflow tells you the
  exact discount you'll pay before you commit.
- You want repeatable, auditable pairings of (credit decision, issuance)
  for your books: every step leaves public, verifiable records.

## When NOT to use

- For invoice amounts below the factoring threshold score (< 500) or when
  the agent is **frozen** — the first API call will reject the deal before
  any Hedera cost is incurred. (This fail-fast guard is part of the recipe.)
- When the receivable is not a clean, undisputed invoice — disputed or
  defaulted outcomes must be excluded upstream.
- For real-money production factoring: ATS `internalKycActivated: true`
  requires a KYC grant to the buyer before transfer; the recipe assumes a
  demo/testnet context or pre-provisioned whitelist.

## Requirements

- Agent controller address (0x…) or ENSv2 name.
- The Graph endpoint (from recipe 01).
- Hedera testnet operator (`HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`),
  ATS `factoryAddress` + `resolverAddress` (see `.env.example`).
- Invoice face value in USD and maturity window in days.

## Steps — the workflow

1. **Credit leg (The Graph).** Query the credit report (recipe 01) for the
   agent. Capture `score` and `frozen`.
2. **Gate.** If `frozen` → **stop**: receivables not eligible. If
   `score < 500` → **stop**: below factoring threshold. If a recent
   `Disputed`/`Default` outcome exists → **stop** until resolved.
   *(Both stop points are priced-in risk guard rails — this is the
   "neither API alone" part: the score that gates spending is the same
   score that decides whether the receivable exists as a tradeable asset.)*
3. **Price.** Discount table — a pure function of the score from step 1:
   `score ≥ 900 → 1%`, `≥ 800 → 3%`, `≥ 650 → 7%`, `≥ 500 → 15%`.
   Sale price = face value × (1 − discount). This is the *underwriting*.
4. **Tokenize (Hedera ATS).** Run
   `integrations/hedera/scripts/tokenize-receivable.js <controller> <faceValue> <maturityDays>`
   — creates the receivable security token with the discount embedded in
   its metadata (`info: { maturityDays, discountRate, agent }`).
5. **Settle.** KYC-grant the buyer on the token (`GrantKycRequest`), then
   transfer the token for the priced amount (ERC-1400 transfer). On
   maturity, the agent pays the face value and the token is redeemed
   (`RedeemRequest`).
6. **Record back to the bureau.** If the counterparty fails to pay the
   invoice, record a `Default` outcome via the bureau's authorized
   reporter — the repo loop: factoring *feeds* the credit history that
   *prices* the next factoring round. No other sponsor stack closes that
   loop.

## Output

- `{ score, decision, discountRate, pricedSaleUsd, hedgeTxId, tokenAddress }`
- Public evidence the judges can check: the Graph query output (report),
  the ATS transaction id + token address on Hedera testnet.

## Why this is a recipe, not two API calls

Step 2's gating and step 3's pricing are **policy**, not API surface. An
agent with only the two raw APIs will happily try to tokenize a frozen
agent's receivable or guess a discount rate. The recipe encodes when/why/
how, so the same task produces the correct guarded, priced issuance on the
first attempt — see `../evidence/compare.js` for the measurement harness.