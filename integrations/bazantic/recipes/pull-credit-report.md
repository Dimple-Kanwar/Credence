# Recipe 01 — Pull an agent's credit report (The Graph)

**API service:** Credence credit report — a The Graph subgraph indexing
CreditBureau onchain events (Sepolia). GraphQL endpoint (Graph Studio /
decentralized network), or the `get_agent_report` MCP tool which wraps it.

## When to use

- Before **extending credit to an autonomous agent**: "is this agent worth
  trusting with $X?"
- Before **accepting an agent as a counterparty / customer** on a
  marketplace, escrow, or job platform.
- Before **factoring an agent's receivable** (combine with recipe 02).
- To **monitor an existing counterparty** — the report is live, every
  query is the current indexed state, and the score history shows the
  trend, not a snapshot.
- When the agent gives you only an **ENSv2 name** (`trader.acme.eth`) and
  you need the underlying controller address and history.

## When NOT to use

- For instant *single-transaction* authorization — the subgraph lags a
  block or two behind the chain; for point-in-time enforcement read
  `CreditBureau.isCreditworthy()` on-chain instead.
- When you need the *raw event* (amount, job id) rather than the
  aggregated report — query `OutcomeRecorded` events directly.
- Protobuf/Substreams streaming use cases — the report is a point-in-time
  pull.

## Requirements

- Controller address (0x…) **or** ENSv2 name of the agent.
- The subgraph endpoint (set once), e.g.
  `https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest`.

## Steps

1. (Only if given an ENSv2 name) resolve it to a controller:
   - either off-chain via the subgraph's `agent(id: namehash)`… or
   - on-chain: `CreditBureau.resolveByEnsName(ensName)`.
2. Query the subgraph for `agent(id: controllerAddress.toLowerCase())`
   with fields: `ensName score humanBacked frozen totalTx successTx
   lateTx disputedTx defaultTx spendLimitWei`, plus
   `outcomes(orderBy: timestamp, orderDirection: desc, first: 20)` for
   the recent history.
3. (Optional) pull `scoreHistory` for the trend chart.
4. Apply the deterministic recommendation on the agent's side (mirrors
   `credit-analyst.js`):
   - `frozen` **or** any `Default` outcome → **decline**, limit 0;
   - `humanBacked` and `score ≥ 800` and clean rate ≥ 0.9 → **approve**,
     double the current limit;
   - `score ≥ 650` and clean rate ≥ 0.75 → **approve with monitoring**;
   - otherwise **review**.
5. Hand the evidence list (score, clean rate, human-backing, frozen flag)
   back to the user — a credit decision must be explainable.

## Output

A JSON credit file: score + tier, human-backing flag, spend limit,
transaction mix, latest 20 outcomes, and an evidence-backed
approve/monitor/decline recommendation. That file is the input to recipe 02
and to any downstream lending decision.

## Demo script for the agent

```
Task: Pull a credit report for trader.agentcreditbureau.eth and state
whether I should extend it a $500 line of credit.

Assistant (recipe-driven, 1 call):
  tool get_agent_report(controller: "trader.agentcreditbureau.eth")
  -> score 862, humanBacked true, clean 200/210, decision approve,
     recommended limit 0.5 ETH window. Conclusion: approve with margin.
```

The same task without the recipe produces a plausible-but-vague answer that
cannot produce the correct GraphQL query shape or the recommendation tiers
on the first attempt — see `../evidence/compare.js` to measure the gap.