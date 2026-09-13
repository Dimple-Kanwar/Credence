# The Graph — Composable & Standardized track playbook (ETHOnline 2026)

Prize page: https://ethglobal.com/events/ethonline2026/prizes#the-graph

> **🧩 Best Use of Composable or Standardized Graph Products — $5,000**
> Requirements: compose **two or more** of The Graph's products **or** build
> meaningfully on a **standardized schema**; consume **live** data from a
> Graph provider (Subgraph Studio / The Graph Network gateway). Explicit
> disqualifier: *"Simply querying one Subgraph with no composition or
> standardization does not qualify."* Authoring/extending a standardized
> subgraph or contributing a composable Substreams module is in scope.

Credence is a **From Scratch** project (built during the event, no prior
project code), so it is also eligible for **Best AI Tooling or AI Use Case
with The Graph (From Scratch)** — the same build below double-dips.

## What the repo now ships (Options A + B)

| Leg | Product | File(s) | Status in UI |
|---|---|---|---|
| CreditBureau subgraph | Subgraphs · Subgraph Studio | `subgraph/` | `live` (probed `_meta`) |
| Messari standardized subgraphs | Standardized Subgraphs · The Graph Network | `backend/integrations/graph/standardized-intel.js` | `live` / `needs-key` |
| The Graph Subgraph MCP | Subgraph MCP · hosted (`subgraphs.mcp.thegraph.com/sse`) | `backend/integrations/mcp/subgraph-mcp-client.js` | `configured` / `needs-key` |
| Substreams pipeline | Substreams · planned (Option C centerpiece) | none yet — see below | `planned` |

### Standardization (Option A)

`standardized-intel.js` runs **ONE GraphQL query shape** — the Messari
standardized backbone — against every protocol subgraph:

```graphql
query StandardProtocolIntel {
  protocols(first: 1) { id name slug schemaVersion subgraphVersion type network totalValueLockedUSD cumulativeTotalRevenueUSD }
  usageMetricsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp dailyActiveUsers dailyTransactionCount }
  financialsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) { timestamp totalRevenueUSD }
}
```

Because every Messari standard subgraph guarantees that backbone, the same
query works across **DEX, Lending and Derivatives** — TVL, revenue and usage
become directly comparable (`crossProtocol` summary in the API). This is the
"one query pattern spanning many protocols" leverage the prize rewards.

Endpoint resolution per provider: `GRAPH_STANDARD_ENDPOINTS` (env pin) →
Subgraph MCP discovery → gateway URL
(`https://api.gateway.thegraph.com/api/{key}/subgraphs/id/{id}`).

### Composition (Option B)

`subgraph-mcp-client.js` connects to **The Graph's official hosted Subgraph
MCP** exactly the way the docs configure Claude/Cursor/Cline:

```bash
npx mcp-remote --header "Authorization:Bearer <GATEWAY_API_KEY>" https://subgraphs.mcp.thegraph.com/sse
```

…but programmatically, over stdio, with the MCP SDK client. It lists the
server's tools at runtime (never hardcodes names), then uses them to:

1. **Discover** live Messari standardized deployments (search by keyword),
2. **Execute** the standardized query against a discovered subgraph id,
3. Route any natural-language prompt to discovery / schema / query tools and
   return a **transcript** of what the official server executed.

So the composition is: custom subgraph (Studio) + standardized subgraphs
(Network) + official Subgraph MCP (hosted) — three Graph products, one screen.

### Where it shows up

- **Backend**: `GET /api/graph/stack`, `POST /api/graph/intel`,
  `POST /api/graph/ask` (`backend/routes.js` → `services/mcp.js`).
- **MCP server**: `get_market_intel(controller?)` + `ask_graph_network(prompt)`
  (`backend/integrations/mcp/server.js`), covered by `npm run smoke`.
- **Frontend**: Graph tools workspace — "Ask The Graph Network",
  "Cross-protocol intel" (per-protocol cards: TVL / revenue 7d / users / tx +
  cross-protocol Σ), and "The Graph stack" live status panel
  (`frontend/src/App.jsx`, styles in `App.css`).

## Going live (what the demo needs)

1. Free Gateway API key at https://thegraph.com/studio/ → `GRAPH_API_KEY` in
   `.env` (backend). No code changes; the `needs-key` legs flip to live.
2. Run the backend + frontend, open **Graph tools**, press *Pull market
   intel* and *Ask*, then narrate the three legs.

> The frontend mocks nothing after that point: every number in the intel
> cards comes from a live Graph provider.

## Option C — Substreams pipeline (video centerpiece)

The AI track names a **featured Substreams challenge**: use the official
**Substreams SKILLs** (https://github.com/streamingfast/substreams-skills,
Claude Code plugin) to go from one natural-language prompt to a working,
deployed Substreams pipeline. Plan:

1. **Reuse before building** — search substreams.dev for existing composable
   modules (StreamingFast `erc20-transfer`, `block-meta`; TopLedger DEX
   modules) per the SKILLs guidance.
2. **Scaffold** a `substreams.yaml` with composed modules streaming
   `CreditBureau` outcome events (or agent-wallet ERC-20 transfers) with the
   SKILLs-driven prompt, deploy to the portal, sink to sqlite/Postgres.
3. **Reconcile** streamed deltas against the subgraph report and surface a
   "live delta" ticker next to the stack panel — Substreams + Subgraph =
   another composed pair, and the composable module can be published to
   substreams.dev (explicitly in scope for the prize).

## Submission checklist

- [ ] Public repo (this one) documents the composition in README + this doc.
- [ ] 2–4 min demo video: score report → `Pull market intel` (standardized
      query across protocols) → `Ask` (official Subgraph MCP transcript) →
      stack panel with all legs live → Substreams delta ticker (Option C).
- [ ] `GRAPH_API_KEY` present in the recording environment; no mocked data.
- [ ] Track name in the submission form: **Best Use of Composable or
      Standardized Graph Products**; pool: **From Scratch** (AI track).