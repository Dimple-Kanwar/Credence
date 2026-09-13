/**
 * standardized-intel.js — cross-protocol intel via Messari Standardized Subgraphs
 *
 * ETHOnline 2026 The Graph track: "Best Use of Composable or Standardized
 * Graph Products". This module runs ONE shared GraphQL query shape against
 * multiple Messari Standardized Subgraphs — every protocol subgraph built to
 * the standard exposes the same backbone (protocols + usageMetricsDailySnapshots
 * + financialsDailySnapshots + semantic version fields), so TVL, revenue and
 * usage across DEXs / lending / derivatives are directly comparable with a
 * single query pattern instead of ten integrations.
 *
 * Endpoint resolution per provider (first hit wins):
 *   1. GRAPH_STANDARD_ENDPOINTS env — JSON map { "<slug>": "<GraphQL URL>" }
 *      (e.g. a Subgraph Studio / gateway URL already in use)
 *   2. The Graph Subgraph MCP discovery (requires GRAPH_API_KEY) — resolves
 *      the live deployment ID and queries it via the Network gateway
 *   3. unresolved -> reported as "needs-key" so the UI can show it as such
 *
 * Only LIVE provider data is consumed (Subgraph Studio / The Graph Network
 * gateway). A provider that fails is reported per-leg, never fatal.
 */

// Curated standardized providers. `contractAddress` is the protocol's canonical
// on-chain address used by the Subgraph MCP to discover its deployments;
// `keyword` is the display-name fragment used as a fallback search term.
// ENV overrides (#1 above) always win so a demo can pin exact endpoints.
const STANDARD_PROVIDERS = [
  {
    slug: "uniswap-v3-ethereum",
    category: "DEX",
    network: "ethereum",
    keyword: "messari/uniswap-v3-ethereum",
    contractAddress: "0x1F98431c8aD98523631AE4a59f267346ea31F984", // Uniswap V3 factory
  },
  {
    slug: "aave-v2-ethereum",
    category: "Lending",
    network: "ethereum",
    keyword: "messari/aave-v2-ethereum",
    contractAddress: "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9", // Aave V2 LendingPool
  },
  {
    slug: "compound-v2-ethereum",
    category: "Lending",
    network: "ethereum",
    keyword: "messari/compound-v2-ethereum",
    contractAddress: "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B", // Compound Comptroller
  },
  {
    slug: "curve-ethereum",
    category: "DEX",
    network: "ethereum",
    keyword: "messari/curve-ethereum",
    contractAddress: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5", // Curve Registry
  },
  {
    slug: "gmx-arbitrum",
    category: "Derivatives",
    network: "arbitrum",
    keyword: "messari/gmx-arbitrum",
    contractAddress: "0x489ee077994B6658eAfA855C308275E8097C9565", // GMX Vault (Arbitrum)
  },
];

// The ONE query shape. Deliberately limited to the standardized backbone so
// the same query is valid on DEX AMM, Lending, Derivatives and Generic
// standardized subgraphs — that portability is the whole point.
const STANDARD_PROTOCOL_QUERY = `
  query StandardProtocolIntel {
    protocols(first: 1) {
      id
      name
      slug
      schemaVersion
      subgraphVersion
      type
      network
      totalValueLockedUSD
      cumulativeTotalRevenueUSD
    }
    usageMetricsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
      timestamp
      dailyActiveUsers
      dailyTransactionCount
    }
    financialsDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc) {
      timestamp
      totalRevenueUSD
    }
  }
`;

function envEndpointOverrides() {
  try {
    const raw = process.env.GRAPH_STANDARD_ENDPOINTS;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Gateway URL shape for a resolved deployment id (The Graph Network). */
function gatewayUrlFor(subgraphId) {
  const key = process.env.GRAPH_API_KEY;
  if (!key || !subgraphId) return null;
  return `https://api.gateway.thegraph.com/api/${key}/subgraphs/id/${subgraphId}`;
}

const percent = (a, b) => (b ? Number(((a / b) * 100).toFixed(1)) : null);

async function probeProvider(provider, endpoint, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const data = await graphFetchWithAbort(endpoint, STANDARD_PROTOCOL_QUERY, {}, controller.signal);
      const protocol = (data.protocols || [])[0] || null;
      const usage = (data.usageMetricsDailySnapshots || []).slice(0, 7);
      const financials = (data.financialsDailySnapshots || []).slice(0, 7);
      const lastUsage = usage[0] || {};
      const lastFinancial = financials[0] || {};
      const sevenDayRevenue = financials.reduce((sum, f) => sum + Number(f.totalRevenueUSD || 0), 0);
      const sevenDayTx = usage.reduce((sum, u) => sum + Number(u.dailyTransactionCount || 0), 0);
      return {
        provider: provider.slug,
        category: provider.category,
        network: protocol?.network || provider.network,
        healthy: true,
        latencyMs: Date.now() - started,
        name: protocol?.name || provider.slug,
        schemaVersion: protocol?.schemaVersion || null,
        subgraphVersion: protocol?.subgraphVersion || null,
        totalValueLockedUSD: protocol?.totalValueLockedUSD ?? null,
        cumulativeTotalRevenueUSD: protocol?.cumulativeTotalRevenueUSD ?? null,
        dailyActiveUsers7d: usage.length ? usage[usage.length - 1].dailyActiveUsers : null,
        latestDailyActiveUsers: lastUsage.dailyActiveUsers ?? null,
        transactions7d: sevenDayTx,
        revenue7dUSD: sevenDayRevenue,
        revenue7dVsTVL: percent(sevenDayRevenue, Number(protocol?.totalValueLockedUSD || 0)),
        snapshotDays: usage.length,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      provider: provider.slug,
      category: provider.category,
      network: provider.network,
      healthy: false,
      latencyMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 160),
    };
  }
}

/** Standalone fetch+abort so probes never hang the report (graphFetch has no abort). */
async function graphFetchWithAbort(endpoint, query, variables, signal) {
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(process.env.GRAPH_API_KEY ? { Authorization: `Bearer ${process.env.GRAPH_API_KEY}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Graph request failed: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  return payload.data;
}

/**
 * Resolve live endpoints for each provider:
 *   overrides (env) -> Subgraph MCP discovery (gateway key) -> null
 */
async function resolveStandardEndpoints() {
  const overrides = envEndpointOverrides();
  let discovered = {}; // slug -> subgraphId (from the official Subgraph MCP)
  if (process.env.GRAPH_API_KEY) {
    try {
      const { discoverStandardProviders } = require("../mcp/subgraph-mcp-client.js");
      discovered = await discoverStandardProviders(STANDARD_PROVIDERS);
    } catch {
      discovered = {}; // discovery is best-effort; overrides still apply
    }
  }

  return STANDARD_PROVIDERS.map((provider) => {
    const endpoint = overrides[provider.slug] || gatewayUrlFor(discovered[provider.slug]);
    return {
      ...provider,
      endpoint: endpoint || null,
      resolvedVia: overrides[provider.slug]
        ? "env override"
        : discovered[provider.slug]
          ? "subgraph-mcp discovery"
          : null,
    };
  });
}

/**
 * Run the standardized query across every resolvable provider and summarize.
 * Never throws for per-provider failures; returns a friendly payload even
 * when nothing is configured (so UIs and the MCP tool can helpfully explain).
 */
async function fetchStandardizedIntel(controller) {
  const resolved = await resolveStandardEndpoints();
  const live = resolved.filter((entry) => entry.endpoint);
  const results = await Promise.allSettled(
    live.map((entry) => probeProvider(entry, entry.endpoint)),
  );

  const providers = results.map((result, index) => ({
    ...(result.status === "fulfilled" ? result.value : { provider: live[index].slug, healthy: false, error: result.reason?.message }),
    resolvedVia: live[index].resolvedVia,
  }));

  const needsKey = resolved.filter((entry) => !entry.endpoint).map((entry) => entry.slug);

  const healthy = providers.filter((p) => p.healthy);
  const summary = {
    liveProviders: healthy.length,
    configuredProviders: live.length,
    needsKey,
    categories: [...new Set(healthy.map((p) => p.category))],
    totalValueLockedUSD: healthy.reduce((sum, p) => sum + Number(p.totalValueLockedUSD || 0), 0),
    cumulativeRevenueUSD: healthy.reduce((sum, p) => sum + Number(p.cumulativeTotalRevenueUSD || 0), 0),
    revenue7dUSD: healthy.reduce((sum, p) => sum + Number(p.revenue7dUSD || 0), 0),
    transactions7d: healthy.reduce((sum, p) => sum + Number(p.transactions7d || 0), 0),
    note:
      healthy.length > 0
        ? `${healthy.length} standardized subgraphs (${healthy.map((p) => p.category).join(", ")}) answered the SAME query shape — one pattern, many protocols.`
        : needsKey.length > 0
          ? `Standardized leg is configured but no provider is resolvable yet — set GRAPH_API_KEY (free, thegraph.com/studio) so the Subgraph MCP can discover ${needsKey.join(", ")}.`
          : "No standardized provider configured. Set GRAPH_STANDARD_ENDPOINTS or GRAPH_API_KEY in .env.",
  };

  return {
    generatedAt: new Date().toISOString(),
    controller: controller || null,
    queryShape: STANDARD_PROTOCOL_QUERY.trim(),
    providers,
    crossProtocol: summary,
  };
}

module.exports = {
  STANDARD_PROTOCOL_QUERY,
  STANDARD_PROVIDERS,
  fetchStandardizedIntel,
  gatewayUrlFor,
  resolveStandardEndpoints,
};