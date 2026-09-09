# Credence MCP Server — pull a credit report in natural language

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns
the on-chain credit bureau into tools any AI agent can call. Every tool reads
from the **live The Graph subgraph** indexing `CreditBureau` events — the
answer an agent gets is the same real, verifiable credit report a human pulls
on the dashboard. Entering an address or ENSv2 name in natural language,
an agent gets an evidence-backed **approve / monitor / decline** decision and
the **score-priced Hedera factoring rate**.

This is the The Graph "Best AI Tooling or AI Use Case" track play: the lag
between "agent needs credit data" and "agent has actionable credit data" is
removed, and the data source stays a sponsor product (a subgraph).

## Tools

| Tool | What it answers |
|---|---|
| `get_agent_report(controller)` | "Is this agent creditworthy? Show me its history." Full report: FICO-style score, tier, spend limit, human-backing, tx counts, latest outcomes, score history, and a deterministic approve/monitor/decline recommendation with evidence. |
| `get_factoring_rate(controller, faceValueUsd?)` | "What would this agent's invoice sell for on Hedera?" Discount rate priced off the live score (1% Prime → 15% New; frozen/below-500 = ineligible). |
| `list_agents(first?)` | "Which agents are the most creditworthy right now?" Ranked credit universe. |

**Resource:** `credence://agent/{controller}` — the same report as a JSON
resource, so agents that know the URI scheme can read it directly.

## Setup

```bash
cd integrations/mcp
npm install

# Point it at the live subgraph (Graph Studio / decentralized network):
GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest \
node server.js
```

Optional env:
- `GRAPH_API_KEY` — for a gated Graph Studio / gateway endpoint.
- `OPENAI_API_KEY` (+ `AI_MODEL_URL`, `AI_MODEL`) — enables the explainable
  narrative leg inside `get_agent_report` (deterministic recommendation works
  without it).
- `SEPOLIA_RPC_URL` + `CREDIT_BUREAU_ADDRESS` — enables passing an **ENSv2
  name** (e.g. `trader.agentcreditbureau.eth`) to any tool; the server
  resolves it on-chain first, then pulls the subgraph report for the
  controller. Addresses (0x…) work without these.

## Connecting to clients

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "credence": {
      "command": "node",
      "args": ["/absolute/path/to/integrations/mcp/server.js"],
      "env": { "GRAPH_ENDPOINT": "https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest" }
    }
  }
}
```

**Cursor** — Settings → MCP → Add server → stdio, same command/args.

**Any agent SDK** — it's stdio MCP; `@modelcontextprotocol/sdk` clients
connect directly (see `test/smoke.js` for a reference client).

Then just ask, in any client:

> "Pull a credit report for `0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F`.
> Should I extend it a line of credit?"

## Verify

```bash
node --check server.js            # syntax
npm run smoke                     # end-to-end: mock subgraph -> real MCP round trip
```

Or inspect live with the official inspector:

```bash
GRAPH_ENDPOINT=... npx @modelcontextprotocol/inspector node server.js
```

## Why The Graph is the source of truth

`CreditBureau.sol` only stores the *latest* profile; the replayable history
(score snapshots, limit changes, every outcome) lives in the subgraph. The
MCP server deliberately queries the subgraph rather than `eth_call`, because
an agent's *underwriting decision* needs history, not a point-in-time read —
and because the whole report stays public and verifiable on the Graph
network, which is exactly what "a credit report a lender can read" means.

## Track mapping

- **The Graph — Best AI Tooling or AI Use Case** (`$5,000`): an MCP server
  is an explicitly listed tooling direction ("new or extended MCP servers",
  "AI agents or apps that use The Graph as their live source of blockchain
  data").
- Natural extension (not yet built): **x402** payment-per-query so an agent
  pays for each report autonomously — the third capability the track
  mentions. Implementing it needs a hosted endpoint + funded agent wallet;
  the deterministic tools above are the contract for it.

## What's next (after the hackathon)

- x402 paywall (see above).
- Standardized-subgraph variant: same report entity across many protocol
  subgraphs (composable track).
- Substreams parallel: incremental credit deltas as streams instead of
  full-report pulls.