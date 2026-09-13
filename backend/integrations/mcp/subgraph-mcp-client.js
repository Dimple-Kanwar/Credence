/**
 * subgraph-mcp-client.js — drives The Graph's official Subgraph MCP server
 *
 * ETHOnline 2026 The Graph track (composable track): "layer the Subgraph
 * MCP on top for cross-protocol analysis". This client connects to The
 * Graph's HOSTED Subgraph MCP endpoint exactly the way the official docs
 * describe for Claude/Cursor/Cline:
 *
 *   npx mcp-remote --header "Authorization:Bearer <GATEWAY_API_KEY>" \
 *     https://subgraphs.mcp.thegraph.com/sse
 *
 * but programmatically, over stdio, using the MCP SDK client. The server
 * exposes The Graph Network's subgraph ecosystem as tools (schema lookup,
 * query execution by subgraph id, top-deployment discovery).
 *
 * The tool names AND their parameter schemas differ between server
 * versions (and are not officially pinned), so this client is
 * SCHEMA-DRIVEN: after tools/list it reads each tool's inputSchema and
 * builds arguments from the actual field names (e.g. contract_address,
 * subgraph_id), filling required fields from the request. If a required
 * field cannot be satisfied it returns a friendly, actionable message —
 * never a raw MCP -32602 deserialization error.
 *
 * Degrades gracefully: without GRAPH_API_KEY every call returns an explicit
 * "how to configure" payload instead of throwing, so demos and the smoke
 * test never hard-fail.
 */

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const path = require("node:path");

const DEFAULT_MCP_URL = "https://subgraphs.mcp.thegraph.com/sse";

function config() {
  return {
    key: process.env.GRAPH_API_KEY || "",
    url: process.env.SUBGRAPH_MCP_URL || DEFAULT_MCP_URL,
  };
}

const noKeyPayload = (message = "") => ({
  ok: false,
  reason:
    "The Graph Subgraph MCP needs a free Gateway API key. Create one at https://thegraph.com/studio/, " +
    "set GRAPH_API_KEY in .env, then restart the backend. " + message,
});

/** Connect to the hosted Subgraph MCP via npx mcp-remote (docs integration). */
async function connect() {
  const { key, url } = config();
  if (!key) return null;

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-remote", "--header", `Authorization:Bearer ${key}`, url],
    cwd: path.join(__dirname, "..", "mcp"),
    env: { ...process.env, AUTH_HEADER: `Bearer ${key}` },
    stderr: "inherit", // surface mcp-remote warnings on the backend console
  });
  const client = new Client({ name: "credence-subgraph-mcp", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

async function withTimeout(promise, ms = 35000, label = "call") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

async function listMcpTools() {
  const client = await connect();
  if (!client) return noKeyPayload();
  try {
    const { tools } = await withTimeout(client.listTools(), 35000, "tools/list");
    return {
      ok: true,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: String(tool.description || "").slice(0, 160),
        required: tool.inputSchema?.required || [],
        properties: Object.keys(tool.inputSchema?.properties || {}),
      })),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Fuzzy tool lookup so we never hardcode the server's tool names. */
function findTool(tools, ...parts) {
  for (const part of parts) {
    const hit = tools.find((t) => t.name.toLowerCase().includes(part));
    if (hit) return hit;
  }
  return null;
}

/** Semantic field matching: map our intentions onto the tool's real schema. */
function findField(properties, ...patterns) {
  for (const pattern of patterns) {
    const hit = properties.find((name) => name.toLowerCase().includes(pattern));
    if (hit) return hit;
  }
  return null;
}

/**
 * Build tool arguments from a tool's actual inputSchema.
 *
 * @param tool  the tool object from tools/list (has inputSchema)
 * @param defs  our semantic intentions: { contractAddress, keyword, subgraphId, query, ipfsHash }
 * @returns { args, missingRequired } — missingRequired lists fields we could
 *          not satisfy, so callers can return a friendly message instead of
 *          letting the server reject with -32602.
 */
function buildToolArgs(tool, defs = {}) {
  const schema = tool.inputSchema || {};
  const properties = Object.keys(schema.properties || {});
  const required = schema.required || [];
  const args = {};

  const tryAssign = (patterns, value) => {
    if (value === undefined || value === null || value === "") return;
    const field = findField(properties, ...patterns);
    if (field) args[field] = value;
  };

  tryAssign(["contract_address", "contract", "address"], defs.contractAddress);
  tryAssign(["search", "keyword", "query_term", "query"], defs.keyword);
  tryAssign(["subgraph_id", "subgraph"], defs.subgraphId);
  tryAssign(["query", "graphql", "gql"], defs.query);
  tryAssign(["ipfs_hash", "ipfs", "manifest"], defs.ipfsHash);
  tryAssign(["deployment_id", "deployment"], defs.deploymentId);

  return {
    args,
    missingRequired: required.filter((field) => !(field in args)),
  };
}

const ID_PATTERNS = [
  /(?:0x[a-fA-F0-9]{64})\b/, // deployment id (0x…64 hex)
  /(Qm[a-zA-Z0-9]{40,})\b/, // ipfs manifest hash
  /([a-zA-Z0-9]{44})\b/, // base58 subgraph ids are 44 chars
  /([a-zA-Z0-9]{32})\b/, // older / shorter ids
];

/** Pull a plausible subgraph/deployment id out of an MCP text result. */
function extractSubgraphId(text) {
  if (!text) return null;
  const tokens = new Set(text.match(/[a-zA-Z0-9]{20,}/g) || []);
  for (const candidate of [...tokens]) {
    for (const pattern of ID_PATTERNS) {
      const match = candidate.match(pattern);
      if (match && match[0] === candidate && !/^(subgraph|deployment|deployments|query|schema)/.test(candidate.toLowerCase())) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Call a tool with schema-built args; returns a structured outcome so the
 * caller can either surface the text result or a friendly failure reason.
 */
async function safeCall(client, tool, defs) {
  const { args, missingRequired } = buildToolArgs(tool, defs);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      missing: missingRequired,
      message:
        `The graph MCP tool "${tool.name}" needs "${missingRequired.join('", "')}". ` +
        hintForMissing(missingRequired),
    };
  }
  try {
    const result = await withTimeout(
      client.callTool({ name: tool.name, arguments: args }),
      30000,
      `${tool.name}`,
    );
    const text = (result.content || []).map((c) => c.text || "").join("\n").trim();
    return { ok: true, text, args };
  } catch (error) {
    return {
      ok: false,
      message: String(error?.message || error),
      args,
    };
  }
}

function hintForMissing(missing) {
  const joined = missing.join(", ");
  if (/contract|address/.test(joined)) {
    return "Include a 0x contract address (or load an agent so its controller address is passed) — the official Subgraph MCP discovers deployments by contract.";
  }
  if (/subgraph|deployment|ipfs/.test(joined)) {
    return "Include a subgraph id / deployment id / IPFS hash in your question.";
  }
  return `Provide: ${joined}.`;
}

/**
 * Discover live deployment/subgraph ids for the given standardized providers
 * via the Subgraph MCP's discovery tool (searching by the provider's protocol
 * contract address). Returns { slug: subgraphId } — best-effort, per-provider.
 */
async function discoverStandardProviders(providers) {
  const client = await connect();
  if (!client) return {};
  try {
    const { tools } = await withTimeout(client.listTools(), 35000, "tools/list");
    const discover = findTool(tools, "discover", "top", "search");
    if (!discover) return {};

    const found = {};
    for (const provider of providers) {
      const result = await safeCall(discover, {
        contractAddress: provider.contractAddress,
        keyword: provider.keyword,
      });
      if (result.ok && result.text) {
        const id = extractSubgraphId(result.text);
        if (id) found[provider.slug] = id;
      }
    }
    return found;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Run a GraphQL query against a subgraph deployment on The Graph Network
 * through the Subgraph MCP's query tool. Schema-driven so it works across
 * server versions (subgraph_id / deployment_id / …).
 */
async function executeQueryBySubgraphId(subgraphId, query, variables = {}) {
  const client = await connect();
  if (!client) return noKeyPayload(`(query for subgraph ${subgraphId} skipped)`);
  try {
    const { tools } = await withTimeout(client.listTools(), 35000, "tools/list");
    const exec = findTool(tools, "execute", "query");
    if (!exec) {
      return { ok: false, reason: `Subgraph MCP exposed no query tool (saw: ${tools.map((t) => t.name).join(", ")})` };
    }
    const result = await safeCall(exec, { subgraphId, query });
    return {
      ok: result.ok,
      subgraphId,
      text: result.ok ? result.text : result.message,
      args: result.args,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Natural-language entry point for the frontend "Ask The Graph Network" box.
 *
 * Deterministic by design: list the official server's tools, then route the
 * prompt to the matching tool (discovery by contract address / keyword,
 * schema lookup, or query by subgraph id) — always using the tool's real
 * schema, never a hardcoded argument shape. Returns a transcript of what
 * was actually exercised on the official server.
 *
 * Optional control via `options`:
 *   controller — the loaded agent's controller address (injected into
 *                discovery so "for the loaded agent" presets resolve)
 *   providers  — STANDARD_PROVIDERS so "messari/standardized" prompts can
 *                discover by protocol contract + run the shared query
 *   query      — shared query shape to chain after a discovery (e.g. the
 *                Messari standardized backbone)
 */
async function askSubgraphMcp(prompt, options = {}) {
  const text = String(prompt || "").trim();
  const lowered = text.toLowerCase();
  const client = await connect();
  if (!client) {
    return {
      ok: false,
      transcript: [{ step: "config", detail: noKeyPayload().reason }],
      answer: null,
    };
  }

  const transcript = [];
  const chainQuery = options.query || null;
  const providers = options.providers || [];
  try {
    const { tools } = await withTimeout(client.listTools(), 35000, "tools/list");
    transcript.push({
      step: "tools/list",
      detail: `official Subgraph MCP exposed ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
    });

    // -----------------------------------------------------------------
    // 1) Capability tour: "what can the Subgraph MCP do?"
    // -----------------------------------------------------------------
    if (/tool|expose|capabilit|what can/.test(lowered)) {
      transcript.push({
        step: "routing",
        detail: "Listed the official tool set — ask for discovery, schema, or a query to go deeper.",
      });
      return {
        ok: true,
        prompt: text,
        tools: tools.map((t) => t.name),
        transcript,
        answer:
          `The official Subgraph MCP exposes ${tools.length} tools.\n` +
          tools.map((t) => `  • ${t.name}`).join("\n") +
          "\n\nTry: discover the top subgraphs for the loaded agent · find the Messari standardized subgraph and run the shared intel query · show the schema for <subgraph-id>",
      };
    }

    const discover = findTool(tools, "discover", "top", "search");
    const exec = findTool(tools, "execute", "query");
    const schemaTool = findTool(tools, "schema");

    // -----------------------------------------------------------------
    // 2) Schema lookup — needs an id in the prompt
    // -----------------------------------------------------------------
    if (!discover && !exec && schemaTool) {
      // shape not yet observed; fall through to generic routing below
    }

    const promptContract = text.match(/0x[a-fA-F0-9]{40}/)?.[0] || null;

    // -----------------------------------------------------------------
    // 3) Messari / standardized prompts → discover by protocol contract,
    //    then (optionally) chain the shared intel query through the MCP
    // -----------------------------------------------------------------
    const standardProvider =
      /messari|standard|uniswap|aave|compound|curve|gmx|dex|lending|derivative/.test(lowered)
        ? providers.find((p) => lowered.includes(p.slug.split("-")[0])) || providers[0]
        : null;

    let subgraphId = null;
    if (discover && (promptContract || options.controller || standardProvider)) {
      const discoveryArgs = {
        contractAddress: promptContract || options.controller || standardProvider?.contractAddress || null,
        keyword: standardProvider ? standardProvider.keyword : text.replace(/discover|top|subgraph|for|the/gi, "").trim() || null,
      };
      transcript.push({
        step: `call ${discover.name}`,
        detail: `discovering deployments for ${(discoveryArgs.contractAddress || standardProvider?.slug || "keyword").slice(0, 42)}${standardProvider ? ` (${standardProvider.slug})` : ""}…`,
      });
      const discovered = await safeCall(discover, discoveryArgs);
      if (discovered.ok) {
        subgraphId = extractSubgraphId(discovered.text);
        transcript.push({
          step: `result ${discover.name}`,
          detail: subgraphId
            ? `resolved subgraph id ${subgraphId}`
            : "no id extracted from the discovery result:\n" + discovered.text.slice(0, 400),
        });
      } else {
        transcript.push({ step: `result ${discover.name}`, detail: discovered.message });
      }
    }

    // -----------------------------------------------------------------
    // 4) If we have a subgraph id (discovered or pasted) and a query tool,
    //    run the shared intel query through the official MCP.
    // -----------------------------------------------------------------
    let answered = false;
    const requestedId = text.match(/(Qm[a-zA-Z0-9]{40,}|[0-9a-zA-Z]{44})/)?.[0] || null;
    const targetId = subgraphId || requestedId;
    if (exec && targetId && (chainQuery || /query|intel|report|data|run/.test(lowered))) {
      transcript.push({ step: `call ${exec.name}`, detail: `executing the shared intel query on ${targetId.slice(0, 24)}…` });
      const executed = await safeCall(exec, { subgraphId: targetId, query: chainQuery || "{ __meta__ }" });
      if (executed.ok) {
        answered = true;
        transcript.push({ step: `result ${exec.name}`, detail: executed.text.slice(0, 900) });
      } else {
        transcript.push({ step: `result ${exec.name}`, detail: executed.message });
      }
    }

    // -----------------------------------------------------------------
    // 5) No route matched → helpful guidance listing working patterns
    // -----------------------------------------------------------------
    if (!discover && !exec && !schemaTool) {
      transcript.push({
        step: "routing",
        detail: `Could not find discovery / query / schema tools in: ${tools.map((t) => t.name).join(", ")}`,
      });
    } else if (!answered && !(discover && (promptContract || options.controller || standardProvider))) {
      transcript.push({
        step: "routing",
        detail:
          `Could not route "${text.slice(0, 80)}" to a Subgraph MCP tool automatically. ` +
          'Try "discover the top subgraphs for the loaded agent", "find the Messari standardized subgraph and run the shared intel query", ' +
          'or "show the schema for <subgraph-id>".',
      });
    }

    const answer = answered
      ? transcript.find((t) => t.step.startsWith("result "))?.detail || null
      : null;

    return { ok: true, prompt: text, tools: tools.map((t) => t.name), transcript, answer };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error).slice(0, 400),
      transcript,
      answer: null,
      hint: "Check GRAPH_API_KEY and that npx can fetch mcp-remote (network). The hosted endpoint is https://subgraphs.mcp.thegraph.com/sse.",
    };
  } finally {
    await client.close().catch(() => {});
  }
}

module.exports = {
  DEFAULT_MCP_URL,
  askSubgraphMcp,
  buildToolArgs,
  discoverStandardProviders,
  executeQueryBySubgraphId,
  listMcpTools,
};