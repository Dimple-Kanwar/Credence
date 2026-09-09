# Credence × Bazantic — recipes for the credit bureau

Bazantic recipes explain to an agent **when, why, and how** to use an API
service — the missing manual an agent needs before it can safely use a tool.
This folder contains the Credence recipes. They pair with the MCP server in
`../mcp/`, which is the executable proof that an agent can run the exact
same workflow the recipe describes.

Reproduce these in the Bazantic recipe editor at **bazantic.com** (create an
MCP server there for the Credence credit report API, or point a tool at the
local `../mcp` server), and include your **Bazantic account username
(email or GitHub handle)** in the submission so the recipe can be
attributed.

## Prizes these target

| Bazantic prize | Amount | Our entry |
|---|---|---|
| **Agentify a new API** | $1,000 | Registering the Credence credit-report API in Bazantic + recipe that agents can reuse (recipe 01). |
| **Best Recipe using sponsor APIs** | $1,000 | Recipe 02 composes **The Graph** (credit report) + **Hedera ATS** (receivable tokenization) into one workflow neither API completes alone. |
| **Help an Agent Use Your Hackathon Project** (Continuity) | $1,000 | The MCP server is the agent-facing manual; `evidence/compare.js` demonstrates the same task with/without the recipe. |

## Recipes

- [`recipes/pull-credit-report.md`](recipes/pull-credit-report.md) — one API:
  The Graph subgraph. Pull an agent's full credit report and get a
  recommendation.
- [`recipes/underwrite-and-factor-agent-receivable.md`](recipes/underwrite-and-factor-agent-receivable.md) —
  two sponsor APIs: The Graph + Hedera ATS. Underwrite an agent, price its
  invoice from its score, and tokenize the receivable — the repeatable
  workflow neither API can do alone.

## Proving the improvement (Continuity prize)

The "Help an Agent Use Your Hackathon Project" track asks for the *same task*
given to the *same model* twice — once with only raw API information, once
with the recipe — and a measurable improvement. Run:

```bash
cd integrations/bazantic
OPENAI_API_KEY=... node evidence/compare.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
```

It sends the same underwriting question to the model with (a) the raw
GraphQL schema and (b) recipe 01, and prints both answers side by side for
the demo — the recipe version should produce the correct `get_agent_report`
call shape on the first attempt.