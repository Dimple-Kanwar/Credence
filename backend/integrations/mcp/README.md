# Credence MCP Server — pull a credit report in natural language

A [Model Context Protocol](https://modelcontextprotocol.io) server that turns
the on-chain credit bureau into tools any AI agent can call. Every tool reads
from the **live The Graph subgraph** indexing `CreditBureau` events — the
answer an agent gets is the same real, verifiable credit report a human pulls
on the dashboard. Entering an address or ENSv2 name in natural language,
an agent gets an evidence-backed **approve / monitor / decline** decision and
the **score-priced Hedera factoring rate**.

This is the The Graph prize-track play for ETHOnline 2026 ("Best Use of
Composable or Standardized Graph Products" + "Best AI Tooling or AI Use
Case with The Graph"): the lag between "agent needs credit data" and
"agent has actionable credit data" is removed, and the data source stays a
sponsor product — a live subgraph, Messari standardized subgraphs, and The
Graph's official hosted Subgraph MCP.

## Tools

| Tool | What it answers |
|---|---|
| `get_agent_report(controller)` | "Is this agent creditworthy? Show me its history." Full report: FICO-style score, tier, spend limit, human-backing, tx counts, latest outcomes, score history, and a deterministic approve/monitor/decline recommendation with evidence. |
| `get_factoring_rate(controller, faceValueUsd?)` | "What would this agent's invoice sell for on Hedera?" Discount rate priced off the live score (1% Prime → 15% New; frozen/below-500 = ineligible). |
| `list_agents(first?)` | "Which agents are the most creditworthy right now?" Ranked credit universe. |
| `get_market_intel(controller?)` | "What's the liquidity / revenue context across protocols?" Runs ONE standardized query shape (Messari backbone: `protocols` + `usageMetricsDailySnapshots` + `financialsDailySnapshots`) across DEX / lending / derivatives subgraphs for directly comparable TVL / revenue / usage. |
| `ask_graph_network(prompt)` | "Find me subgraphs indexing this contract" — routes natural language to **The Graph's official hosted Subgraph MCP** (schema lookup, query-by-subgraph-id, top-deployment discovery) and returns a transcript of what it executed. |

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
- `GRAPH_API_KEY` — for a gated Graph Studio / gateway endpoint. Also powers
  the **composable legs**: standardized-subgraph discovery and the official
  hosted **Subgraph MCP** (`ask_graph_network` / `get_market_intel`).
- `GRAPH_STANDARD_ENDPOINTS` — JSON map `{ slug: GraphQL URL }` to pin
  standardized providers directly (beats MCP discovery when an id is known).
- `SUBGRAPH_MCP_URL` — overrides the hosted Subgraph MCP endpoint
  (default `https://subgraphs.mcp.thegraph.com/sse`).
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

## Track mapping (ETHOnline 2026)

- **The Graph — Best Use of Composable or Standardized Graph Products**
  (`$5,000`): the composable legs are live in this server —
  `get_market_intel` consumes Messari Standardized Subgraphs with one shared
  query shape (standardization), and `ask_graph_network` layers The Graph's
  hosted Subgraph MCP over that data (composition: custom subgraph +
  standardized subgraphs + official Subgraph MCP). Live providers only —
  Subgraph Studio for the project subgraph, The Graph Network gateway for
  the standardized legs.
- **The Graph — Best AI Tooling or AI Use Case with The Graph (From
  Scratch)** (`$5,000`): this server is "new MCP tooling" in the explicit
  sense of the track — agents get an evidence-backed credit report, the
  score-priced Hedera factoring rate, cross-protocol market intel, and
  natural-language access to The Graph Network through the official
  Subgraph MCP.

## What's next (after the hackathon)

- x402 paywall for `get_agent_report` (see `pay_for_credit_report` for the
  contract it implements).
- **Substreams pipeline (video centerpiece)**: real-time credit deltas as
  streams instead of point-in-time pulls — scaffold with the official
  Substreams SKILLs, reuse a composable package from substreams.dev, and
  reconcile against the subgraph report. See
  `docs/graph-composable-track.md`.