# ETHGlobal ETHOnline 2026 Submission Feedback

## Project
Ledger — "FICO for AI Agents"

## What it does
This project creates an on-chain credit and reputation layer for autonomous agents. Agents gain a portable ENSv2 identity, a human-backed trust signal via World AgentKit, and an enforceable spend limit built from their transaction history. The system indexes those outcomes with The Graph and can price receivables or financing off the resulting score on Hedera.

## Sponsor integration summary
- ENSv2: agent identity and hierarchy
- World: human-backing and Sybil resistance
- The Graph: live indexed data and AI underwriting recommendation
- Hedera: tokenized receivables priced off score
- Contracts: CreditBureau and CreditEscrow enforce the risk policy on-chain

## Demo narrative
1. Register an ENSv2 agent subname.
2. Verify the human backing via World AgentBook / AgentKit.
3. Record a healthy transaction history and show the bureau updates the score.
4. Show the Graph-powered risk recommendation and dashboard.
5. Show live Hedera tokenization pricing for a qualified receivable.
6. Demonstrate a frozen or defaulted agent being denied policy approval.

## Developer experience notes
- Local validation is done with Hardhat, Vite, and The Graph build tooling.
- Live proof requires valid Sepolia, World, Graph, and Hedera credentials in `.env`.
- The code is open source and structured for a clean sponsor demo, with deployment artifacts and scripts for each sponsor leg.

## Submission recommendation
This project is strongest when pitched as a single product story: identity -> trust -> credit -> automation -> financing. That narrative is clearer and more compelling than a general multi-sponsor mashup and aligns closely with the sponsor tracks for ENS, World, The Graph, and Hedera.
