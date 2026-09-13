# Credence Demo Script (aim for 3 minutes)

1. **The problem (20s).** "AI agents are starting to pay for things
   autonomously, but there's no credit system — you either fully trust an
   agent or babysit it." Show the trust-vacuum slide/talking point.

2. **Register an agent (20s).** Run `register-single-agent.js` live (or show the
   tx on Sepolia Etherscan) — agent gets `trader.agentcreditbureau.eth`, its own
   Permissioned Resolver, and CreditBureau is EAC-scoped to its spend-limit
   text record. Then show the World AgentKit human-backing verification
   confirming on-chain.

3. **Score climbs (40s).** Run `simulate-agent.js good 60` against an
   agent you registered in the frontend — the script only drives the
   on-chain history (score + spend limit react to each outcome). Show the
   dashboard's score number ticking up and the spend limit tier upgrading
   live — narrate the tiers as they cross ($10/day -> higher tiers). Point out
   that the limit change also lands in the agent's own ENS name records
   (sepolia etherscan -> resolver -> text records).

4. **A default freezes it (30s).** On a *second* demo agent, run
   `simulate-agent.js default 1`. Show the score cap, the spend limit drop
   to zero, and the dashboard's "Frozen" status flip red.

5. **The Graph query (20s).** Pull up the Subgraph Studio playground and
   run the `AgentHistory` query live against the good agent — "this is a
   live, queryable credit report anyone can pull."

6. **Receivables factoring on Hedera (40s).** Run
   `tokenize-receivable.js <goodAgent> 1000 30` and `tokenize-receivable.js
   <frozenAgent> 1000 30` back to back — show the good agent gets a tight
   ~3-7% discount, the frozen agent is rejected outright. "The same score
   that gates spending also prices how cheaply this agent can raise
   working capital against its future invoices."

7. **Close (10s).** Restate the one-liner: "A portable, on-chain FICO score
   for machines — so strangers can extend credit and responsibility to
   agents safely."

## Recording checklist

- [ ] Two demo agents pre-registered (one "good," one ready to default) so
      you don't wait on 60 live transactions during recording.
- [ ] Subgraph fully synced before recording — check the Studio playground
      returns data before hitting record.
- [ ] Have Etherscan tabs pre-opened to the CreditBureau contract and the
      registration/outcome transactions you'll reference.
- [ ] Confirm `.env` values are filled for whichever network you're demoing
      on (Sepolia for ENSv2/World/Graph legs, Hedera testnet for ATS leg).
