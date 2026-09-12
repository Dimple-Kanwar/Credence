# Credence Architecture

## Data flow

1. **Birth.** An agent is registered: it gets an ENSv2 subname (identity)
   and, ideally, a World AgentKit human-backing proof before or shortly
   after calling `CreditBureau.registerAgent()`.
2. **Transacting.** As the agent completes jobs, pays invoices, or defaults,
   an authorized reporter (a marketplace, escrow, or job contract — or the
   simulator, for demo purposes) calls `recordOutcome()`. This is the only
   privileged write path into the bureau.
3. **Indexing.** The Graph subgraph listens to `OutcomeRecorded`,
   `ScoreUpdated`, and `SpendLimitUpdated` events and builds a live,
   queryable "credit report" per agent (`Agent`, `Outcome`,
   `ScoreSnapshot` entities).
4. **Enforcement.** `CreditBureau._computeLimit()` sets a spend limit
  tier based on score + transaction count. Every limit change is also
  written into the agent's own ENSv2 Permissioned Resolver as the
  `com.agentcreditbureau.spend-limit-wei` text record, through the
  `ROLE_SET_TEXT` grant the agent scoped to exactly that key — so the
  limit is visible on the resolvable name itself, not just inside the
  bureau. `CreditEscrow.settleJob()` checks that limit before forwarding
  payment and records the successful outcome through its authorized
  reporter role, so the limit is enforced on-chain.
5. **Receivables market.** Any service (or the demo script) can query an
   agent's score and, if above the factoring threshold, tokenize an
   outstanding invoice as a Hedera ATS asset. The discount rate applied is
   a direct, transparent function of the score — a lender/liquidity
   provider is pricing risk off publicly verifiable on-chain history rather
   than a manual underwriting call.
6. **Agent access layer.** The MCP server (`backend/integrations/mcp`) re-exposes
   the subgraph as natural-language tools — `get_agent_report`,
   `get_factoring_rate`, `list_agents` — so any AI agent can pull a credit
   report and act on it directly. The Bazantic recipes
   (`backend/integrations/bazantic`) are the manual for those tools, including the
   two-sponsor-API workflow (The Graph underwriting -> Hedera issuance)
   that neither API completes alone.

## Why this decomposition

- **Identity and reputation are separated from enforcement.** ENSv2 owns
  "who is this," CreditBureau owns "how trustworthy have they been," and
  EAC/Ledger own "what are they allowed to do right now." This mirrors how
  real credit bureaus (data) are separate from lenders (decisions).
- **The score is computed from on-chain events only.** No off-chain
  database of truth — anyone can re-derive the score by replaying events,
  which is what makes it "portable and on-chain, not locked inside one
  platform."
- **Human-backing is a bonus, not a gate.** An unbacked agent can still
  build reputation, just starting from a lower base and half the initial
  limit — this avoids excluding legitimate autonomous agents while still
  pricing in Sybil risk.

## What's external vs. real for the hackathon

- `CreditBureau.sol`, `CreditEscrow.sol`, their tests, the subgraph mapping,
  and the Graph credit analyst are runnable against a local Hardhat network or
  a live Graph endpoint.
- ENSv2 is real end-to-end on Sepolia: `setup-agent-namespace.js` registers
  the project root `.eth` name, deploys the project UserRegistry proxy and the
  `AgentSubnameRegistrar` (via the documented commit-reveal ETHRegistrar flow
  and `ENSV2_PAYMENT_TOKEN`); `register-single-agent.js` mints each agent's
  subname with its own Permissioned Resolver; `CreditBureau.registerAgent()`
  verifies subname ownership on-chain and persists every spend-limit change
  into the agent's resolver text record through the scoped EAC role.
- World AgentKit requires the agent wallet to be registered through the
  AgentBook CLI; the verification script checks live AgentBook status before
  updating the bureau.
- Hedera ATS issuance uses the installed asset-tokenization SDK and requires
  the testnet operator plus ATS factory/resolver configuration.

## Known simplifications (say these out loud in the demo, don't hide them)

- Scoring formula is intentionally simple/transparent for demo clarity, not
  a production-grade credit model.
- One reporter role model (single authorized reporter) rather than a
  marketplace-of-reporters reputation-weighting scheme.
- Receivables tokenization is a single flat instrument per invoice rather
  than a pooled/tranche factoring market — a natural v2 direction.
