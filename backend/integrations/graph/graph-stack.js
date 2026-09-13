/**
 * graph-stack.js — live status of every leg of the Graph composition, shown
 * in the frontend "Stack" panel so judges see the standardization/composition
 * leverage of the project at a glance:
 *
 *   1. agent-credit-bureau subgraph (Subgraph Studio — custom leg)   [live]
 *   2. standardized subgraphs (Messari — via gateway/Subgraph MCP)   [live | needs-key]
 *   3. The Graph Subgraph MCP (hosted, natural-language)             [configured | needs-key]
 *   4. Substreams pipeline (video centerpiece, planned)              [planned]
 *
 * Each leg is probed independently; a failure marks that leg only.
 */

const STANDARD_PROVIDERS = require("./standardized-intel.js").STANDARD_PROVIDERS;

async function probeOwnSubgraph() {
  const endpoint = process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL;
  if (!endpoint) return { enabled: false, status: "off", detail: "GRAPH_ENDPOINT / VITE_SUBGRAPH_URL not set" };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } agents(first: 1) { id } }" }),
      });
      if (!response.ok) return { enabled: true, status: "off", detail: `HTTP ${response.status}` };
      const payload = await response.json();
      const block = payload?.data?._meta?.block?.number;
      return {
        enabled: true,
        status: block ? "live" : "off",
        detail: block ? `synced to block ${block}` : "no _meta (indexing?)",
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { enabled: true, status: "off", detail: String(error?.message || error).slice(0, 120) };
  }
}

function standardizedLeg() {
  if (!process.env.GRAPH_API_KEY && !process.env.GRAPH_STANDARD_ENDPOINTS) {
    return { enabled: true, status: "needs-key", detail: "set GRAPH_API_KEY (thegraph.com/studio) or GRAPH_STANDARD_ENDPOINTS to enable" };
  }
  const overrides = (() => {
    try { return JSON.parse(process.env.GRAPH_STANDARD_ENDPOINTS || "{}"); } catch { return {}; }
  })();
  const pinned = Object.values(overrides).filter(Boolean).length;
  return {
    enabled: true,
    status: "configured",
    detail: `${STANDARD_PROVIDERS.length} Messari providers (${pinned} pinned via GRAPH_STANDARD_ENDPOINTS, rest discovered via Subgraph MCP)`,
  };
}

function mcpLeg() {
  if (!process.env.GRAPH_API_KEY) {
    return { enabled: true, status: "needs-key", detail: "set GRAPH_API_KEY to talk to the hosted Subgraph MCP (subgraphs.mcp.thegraph.com/sse)" };
  }
  return { enabled: true, status: "configured", detail: `auth set (URL ${process.env.SUBGRAPH_MCP_URL || "subgraphs.mcp.thegraph.com/sse"})` };
}

async function graphStackStatus() {
  const [own, standard, mcp] = await Promise.all([probeOwnSubgraph(), Promise.resolve(standardizedLeg()), Promise.resolve(mcpLeg())]);
  return {
    generatedAt: new Date().toISOString(),
    legs: [
      {
        id: "credit-subgraph",
        label: "CreditBureau subgraph",
        product: "Subgraphs · Subgraph Studio",
        description: "Custom subgraph indexing CreditBureau events into a live credit report.",
        ...own,
      },
      {
        id: "standardized",
        label: "Messari standardized subgraphs",
        product: "Standardized Subgraphs · The Graph Network",
        description: `One shared query shape across ${STANDARD_PROVIDERS.length} protocol subgraphs (DEX, lending, derivatives).`,
        ...standard,
      },
      {
        id: "subgraph-mcp",
        label: "The Graph Subgraph MCP",
        product: "Subgraph MCP · hosted",
        description: "Official natural-language gateway to The Graph Network (schema lookup, query by subgraph id, discovery).",
        ...mcp,
      },
      {
        id: "substreams",
        label: "Substreams pipeline",
        product: "Substreams · planned",
        description: "Streaming credit deltas + agent-wallet activity as the video centerpiece (substreams.dev composable packages).",
        enabled: false,
        status: "planned",
        detail: "Scaffold with the Substreams SKILLs during the event — see docs/graph-composable-track.md",
      },
    ],
  };
}

module.exports = { graphStackStatus };