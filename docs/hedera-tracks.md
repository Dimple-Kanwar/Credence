# Hedera — two tracks, one loop

Credence targets **both** Hedera prizes at ETHOnline 2026 (Hedera's pool is
**$15,000**: two $6,000 tracks × up to 3 teams, plus smaller support prizes).
Both tracks compose into a single loop on one ledger, priced by one credit
oracle:

```text
agent earns       -> CreditBureau scores it (Sepolia)  -> The Graph indexes it
                   -> score prices the receivable (ATS bond, discount curve)
                   -> LP buys the bond (compliance-enforced transfer)
                   -> maturity pays out (ATS redemption / Scheduled Tx)
                   -> agent pays for its own next credit call in HBAR (x402)
```

The report an AI agent **pays for in HBAR** (x402 track) is the same report
that **prices its receivable tokenization** (tokenization track). Payment
rail and asset rail share one ledger and one credit oracle.

---

## Track 1 — 🤖 AI & Agentic Payments on Hedera ($6,000)

### Prize requirements (from the ETHGlobal prize page)

> The agentic economy needs payment rails that work at machine speed:
> sub-second finality, predictable sub-cent fees, and native token operations
> without smart contract overhead.

Qualification requirements:

1. **Host a live x402-gated service on Hedera testnet or mainnet, settled
   through the Blocky402 facilitator.**
2. **Build a platform or agent that consumes that service and completes at
   least one real paid request end to end.**
3. Public GitHub repo.

Idea the page lists that Credence maps to directly: *"Metered data feed.
Price by query, settle per request, no seats or subscriptions"* — and our
credit analysts double as the *"pay-per-call inference endpoint"* leg.

### What we built

| Requirement | Implementation |
|---|---|
| x402-gated service, Blocky402-settled | Unified `backend/server.js` — `GET /credit-report/:controller` (100 tinybar) and `GET /factoring-rate/:controller` (50 tinybar) over x402 v2 **exact-Hedera**; server holds **no private key**; verify + settle via `https://api.testnet.blocky402.com` (`x402/facilitator.js`), with a Mirror-node cross-check on `DUPLICATE_TRANSACTION` settles so delivery stays provable |
| Consuming agent, real paid request | `backend/integrations/hedera/x402/buyer.js` — unpaid GET → 402 → signs an HBAR transfer payload from the agent's own wallet (`@x402/hedera` `ExactHederaScheme` + `createClientHederaSigner`) → retries with `X-PAYMENT` → prints report + tx + HashScan link |
| Platform that consumes it | `backend/integrations/hedera/x402/agent-demo.js` — an autonomous loop that discovers both services, budgets, pays per call, and turns the paid reports into an approve/monitor/decline + factoring decision; **MCP server** (`backend/integrations/mcp`) exposes `pay_for_credit_report` so any agent SDK can pay from its own wallet (`node backend/integrations/mcp/cli.js pay_for_credit_report <controller>`) |

### Demo script (end to end)

```bash
# 1. a funded testnet payer wallet (agent wallet) — https://portal.hedera.com
#    set X402_PAYER_ACCOUNT / X402_PAYER_KEY (or HEDERA_OPERATOR_ID / key)

# 2. start the x402 service (payments go to HEDERA_OPERATOR_ID / X402_PAY_TO)
cd backend/integrations/hedera
npm run start:x402

# 3. the consuming agent pays for one report, end to end
node x402/buyer.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F report
#    expect: 402 -> sign -> X-PAYMENT -> 200 report + payment.transactionId
#    then confirm the CRYPTOTRANSFER SUCCESS on the printed HashScan link

# 4. the autonomous agent: discover -> pay (report + rate) -> decide
node x402/agent-demo.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
```

Evidence to capture for the submission: the printed `payment.transactionId`
per call, two HashScan SUCCESS screenshots (one per service), and the
agent-demo decision output.

---

## Track 2 — 🪙 Tokenization of Anything ($6,000)

### Prize requirements (from the ETHGlobal prize page)

> Real asset classes and real lifecycle management will be favoured over a
> token with a name on it.

Qualification:

1. Use the **Asset Tokenization Studio** (SDK, contracts, or web app) to
   issue or manage a tokenised asset.
2. Deploy and demonstrate on **Hedera testnet**.
3. Public GitHub repo, contracts verified on HashScan where applicable.
4. **Demo video ≤ 5 min** showing issuance, configuration, and at least one
   lifecycle operation (transfer, compliance check, or distribution).

Ideas we map to: **"Cashflow tokenisation. Invoices, receivables, or royalty
streams sold at a discount and settled on maturity."**

### What we built

| Lifecycle leg | Implementation |
|---|---|
| Issuance | `scripts/tokenize-receivable.js` — an agent's invoice is issued as an ATS **Bond** (zero-coupon): face units, `startingDate`/`maturityDate`, whitelist + internal KYC on, priced off the credit score (1% Prime … 15% New; not eligible <500 / frozen) |
| Pricing oracle | `scripts/quote-factoring.js` — live score → discount → LP buy price. The oracle is on-chain CreditBureau → The Graph → the ATS curve; also served as the x402 `factoring-rate` service so agents pay per quote |
| Secondary market / transfer | `scripts/transfer-receivable.js` — `Security.transfer({securityId, targetId, amount})`: the LP purchase leg; ATS compliance modules enforce whitelist + KYC grant at transfer time (un-whitelisted buyer rejected = "compliance checks in use") |
| Redemption at maturity | `scripts/redeem-at-maturity.js` — `Bond.redeemAtMaturityByPartition` (ERC-3643/1400 partition flow; `DEFAULT_PARTITION` bytes32) |
| Scheduled settlement | `scripts/schedule-maturity-settlement.js` — **Hedera Scheduled Transactions**: mode `contract` schedules `redeemAtMaturityByPartition` on the bond diamond; mode `transfer` schedules the cash leg (HbarTransfer borrower→LP). Nobody must be online at maturity |

### Extra points we hit

Per the track page's "Extra points" list:

- ✅ **A secondary market for ATS-issued assets, which the Studio does not
  have today** — `transfer-receivable.js` is a liquidity-provider market leg
  with compliance enforced at transfer (we deliberately built the market
  surface the Studio lacks; the dashboard advertises it).
- ✅ **Compliance controls in use** — the bond is issued `isWhiteList: true`
  + `internalKycActivated: true`; transfers run the token's own KYC grant /
  whitelist checks; the issuance script can be extended with external pause/
  control lists (`externalPausesIds`, `externalControlListsIds`).
- ✅ **Custom fee schedules / coupon / royalty flows** — issuing as a Bond
  makes coupon schedules available (`Bond.setCoupon`, `getCoupons`); a
  royalty-stream version is one `kind: "royalty"` info field away.
- ✅ **Oracle integration for asset pricing** — the discount/NAV curve is a
  live oracle: CreditBureau (Sepolia) → The Graph → x402 `factoring-rate`
  → ATS issuance.
- ✅ **Scheduled Transactions for vesting, coupon payments, or maturity
  settlement** — `schedule-maturity-settlement.js` (Hedera-native; the only
  mainstream L1 with native scheduling).
- 🔶 **Contributions back upstream to ATS** — optional; the lifecycle scripts
  double as clean examples of the SDK for the ATS repo.

### Demo video outline (≤ 5 min)

1. Pull a live credit report (dashboard / MCP) — score visible.
2. `npm run quote -- <controller>` — the oracle price.
3. `npm run tokenize -- <controller> 1000 30` — issuance; show HashScan.
4. `npm run transfer -- <token> <lp> <units>` — LP purchase; show the
   compliance check + transfer tx.
5. `npm run schedule -- <token> <lp> 1000 contract <maturityTs>` and/or
   `npm run redeem -- <token> <lp> <units>` — Scheduled Transaction +
   redemption at maturity.
6. (Optional cross-track) `node x402/buyer.js <controller> report` — the
   agent PAYS for the report that priced the receivable.

---

## Shared notes

- All Hedera scripts reuse `backend/integrations/hedera/scripts/lib/ats.js`
  (connection + the single discount curve + HashScan helpers) so the oracle
  can never drift between the x402 quote, the ATS issuance, and the docs.
- Track page links: ATS monorepo
  https://github.com/hashgraph/asset-tokenization-studio · ATS SDK
  https://www.npmjs.com/package/@hashgraph/asset-tokenization-sdk · Hedera
  scaffold https://github.com/hedera-dev/scaffold-hbar · x402 spec
  https://x402.org · x402 Hedera mechanism `@x402/hedera` · Blocky402
  facilitator `https://api.testnet.blocky402.com` (/supported, /verify,
  /settle).
- Testnet faucet for the agent wallet: https://portal.hedera.com. The x402
  payer and the ATS issuer can be the same Hedera account; put a few HBAR
  on each.