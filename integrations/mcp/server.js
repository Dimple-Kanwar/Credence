/**
 * server.js — Credence MCP server (Model Context Protocol)
 *
 * Exposes the on-chain credit bureau as natural-language tools for AI
 * agents. Every tool reads from the live The Graph subgraph (the indexed
 * CreditBureau events), so the answer an agent gets is the same real,
 * verifiable credit report a human would pull on the dashboard.
 *
 * The Graph prize track ("Best AI Tooling or AI Use Case with The Graph")
 * explicitly rewards agent tooling over The Graph's data — this server is
 * that tooling: any MCP client (Claude Desktop, Cursor, Claude Code, any
 * agent SDK) can say "pull a credit report for 0x…" and get an
 * evidence-backed approve/monitor/decline recommendation plus the
 * score-priced Hedera factoring rate.
 *
 * Usage:
 *   GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest \
 *   node server.js
 *
 *   # optional: OPENAI_API_KEY=enables the explainable narrative leg
 *   # optional: GRAPH_API_KEY=for a gated Graph Studio / gateway endpoint
 *
 * Tools:
 *   - get_agent_report(controller)  full credit report + recommendation
 *   - get_factoring_rate(controller)  score-priced receivables discount
 *   - list_agents(first)           top-ranked agents in the bureau
 *
 * Resources:
 *   - credence://agent/{controller}  same report as a JSON resource
 */
require("dotenv").config();

const { McpServer, ResourceTemplate } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { isAddress, ZeroAddress, JsonRpcProvider, Contract } = require("ethers");
const { analyzeAgent } = require("../graph/credit-analyst.js");

const SERVER_NAME = "credence-credit-bureau";
const SERVER_VERSION = "0.1.0";

/**
 * Score -> Hedera factoring discount (mirrors integrations/hedera and the
 * frontend's credit.js: price of risk is a transparent function of score).
 */
function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null; // not eligible for factoring
}

/** Keep tool payloads readable: pick the report fields an agent actually uses. */
function summarizeReport({ agent, recommendation, narrative }) {
  return {
    ensName: agent.ensName,
    controller: agent.controller ?? null,
    score: agent.score,
    tier: scoreTier(agent.score),
    humanBacked: agent.humanBacked,
    frozen: agent.frozen,
    totalTx: agent.totalTx,
    successTx: agent.successTx,
    lateTx: agent.lateTx,
    disputedTx: agent.disputedTx,
    defaultTx: agent.defaultTx,
    spendLimitWei: agent.spendLimitWei,
    latestOutcomes: (agent.outcomes || []).slice(0, 10).map((o) => ({
      outcomeType: o.outcomeType,
      amountWei: o.amountWei,
      timestamp: o.timestamp,
    })),
    recentScoreHistory: (agent.scoreHistory || []).slice(0, 5),
    recommendation: {
      decision: recommendation.decision,
      recommendedLimitWei: recommendation.recommendedLimitWei,
      cleanRate: Number(recommendation.cleanRate.toFixed(4)),
      evidence: recommendation.evidence,
    },
    narrative: narrative || null,
  };
}

function scoreTier(score) {
  if (score >= 900) return "Prime";
  if (score >= 800) return "Established";
  if (score >= 650) return "Building";
  if (score >= 500) return "New";
  return "Restricted";
}

/** GraphQL: top agents by score, for `list_agents`. */
const LIST_AGENTS_QUERY = `
  query ListAgents($first: Int!) {
    agents(orderBy: score, orderDirection: desc, first: $first) {
      ensName
      score
      humanBacked
      frozen
      totalTx
      defaultTx
      spendLimitWei
      updatedAt
    }
  }
`;

async function graphFetch(query, variables) {
  const endpoint = process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL;
  if (!endpoint) {
    throw new Error(
      "No subgraph endpoint configured. Set GRAPH_ENDPOINT (or VITE_SUBGRAPH_URL) to the live Graph provider endpoint."
    );
  }
  const response = await fetch(endpoint, {
    method: "POST",
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

const toolError = (message, hint) => {
  const text = hint ? `${message}\n${hint}` : message;
  return { content: [{ type: "text", text }], isError: true };
};

/**
 * Accept either a controller address (0x…) or an ENSv2 name. Names are
 * resolved on-chain via CreditBureau.resolveByEnsName() — the subgraph
 * keys agents by controller address, so the report lookup needs the
 * resolved address. Fails with a helpful message when the name cannot be
 * resolved or the resolution env is missing.
 */
async function resolveController(input) {
  const trimmed = String(input).trim();
  if (isAddress(trimmed)) return trimmed;

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  const bureauAddress = process.env.CREDIT_BUREAU_ADDRESS;
  if (!rpcUrl || !bureauAddress) {
    throw new Error(
      `"${trimmed}" looks like an ENSv2 name; set SEPOLIA_RPC_URL and CREDIT_BUREAU_ADDRESS to resolve it on-chain.`
    );
  }
  const provider = new JsonRpcProvider(rpcUrl);
  const bureau = new Contract(
    bureauAddress,
    ["function resolveByEnsName(string ensName) external view returns (address)"],
    provider
  );
  const controller = await bureau.resolveByEnsName(trimmed);
  if (controller === ZeroAddress) {
    throw new Error(`No controller is registered for ENS name "${trimmed}".`);
  }
  return controller;
}

async function main() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // ---------------------------------------------------------------------
  // get_agent_report — the core "pull a credit report" tool
  // ---------------------------------------------------------------------
  server.registerTool(
    "get_agent_report",
    {
      title: "Pull an agent credit report",
      description:
        "Pull the full on-chain credit report for an autonomous agent from the Credence credit bureau (The Graph-indexed CreditBureau events). Returns the FICO-style score, spend limit, transaction history, an evidence-backed approve/monitor/decline recommendation, and the recent score history. Accepts a controller address (0x…) or an ENSv2 name (e.g. trader.agentcreditbureau.eth).",
      inputSchema: {
        controller: z
          .string()
          .describe("Agent controller address (0x…) or ENSv2 name, e.g. trader.agentcreditbureau.eth"),
      },
    },
    async ({ controller: input }) => {
      try {
        const controller = await resolveController(input);
        const report = await analyzeAgent(controller);
        report.agent.controller = controller;
        return {
          content: [{ type: "text", text: JSON.stringify(summarizeReport(report), null, 2) }],
        };
      } catch (error) {
        const resolutionHint =
          error.message && /ENSv2 name|controller is registered|SEPOLIA_RPC_URL/.test(error.message)
            ? error.message
            : "Check the address/name is registered in CreditBureau, the subgraph is synced past that agent's registration, and GRAPH_ENDPOINT points at the deployed subgraph.";
        return toolError(`Could not pull a credit report for "${input}".`, resolutionHint);
      }
    }
  );

  // ---------------------------------------------------------------------
  // get_factoring_rate — the Hedera receivable price, priced off the score
  // ---------------------------------------------------------------------
  server.registerTool(
    "get_factoring_rate",
    {
      title: "Price an agent receivable (Hedera factoring rate)",
      description:
        "Return the discount rate at which an agent's outstanding invoice would be tokenized and sold on Hedera ATS, priced directly off the agent's live credit score (1% at Prime … 15% at New; not eligible below 500 or when frozen). Useful for an agent or liquidity provider deciding whether to factor a receivable.",
      inputSchema: {
        controller: z
          .string()
          .describe("Agent controller address (0x…) or ENSv2 name, e.g. trader.agentcreditbureau.eth"),
        faceValueUsd: z
          .number()
          .positive()
          .optional()
          .describe("Optional invoice face value in USD to compute the priced sale amount"),
      },
    },
    async ({ controller: input, faceValueUsd }) => {
      try {
        const controller = await resolveController(input);
        const { agent } = await analyzeAgent(controller);
        if (agent.frozen) {
          return {
            content: [
              {
                type: "text",
                text: `Agent ${agent.ensName || controller} is FROZEN (a default was recorded) — receivables are NOT eligible for factoring.`,
              },
            ],
          };
        }
        const discountRate = discountRateForScore(agent.score);
        const eligible = discountRate !== null;
        const salePrice =
          eligible && faceValueUsd ? Number((faceValueUsd * (1 - discountRate)).toFixed(2)) : null;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  controller,
                  ensName: agent.ensName,
                  score: agent.score,
                  eligible,
                  discountRate: eligible ? discountRate : null,
                  discountPercent: eligible ? discountRate * 100 : null,
                  faceValueUsd: faceValueUsd ?? null,
                  pricedSaleUsd: salePrice,
                  note: eligible
                    ? "Tokenize via integrations/hedera/scripts/tokenize-receivable.js on Hedera testnet."
                    : "Score below the 500 factoring threshold.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        const resolutionHint =
          error.message && /ENSv2 name|controller is registered|SEPOLIA_RPC_URL/.test(error.message)
            ? error.message
            : "See get_agent_report for diagnosis.";
        return toolError(`Could not price a receivable for "${input}".`, resolutionHint);
      }
    }
  );

  // ---------------------------------------------------------------------
  // list_agents — credit universe browse
  // ---------------------------------------------------------------------
  server.registerTool(
    "list_agents",
    {
      title: "List credit bureau agents",
      description:
        "List the agents tracked by the credit bureau, ranked by credit score (highest first). Returns up to `first` agents with ensName, score, human-backing status, frozen flag, and transaction counts — useful to survey the credit universe before picking a counterparty or lending target.",
      inputSchema: {
        first: z.number().int().min(1).max(100).optional().describe("Number of agents to return (default 10)"),
      },
    },
    async ({ first = 10 }) => {
      try {
        const data = await graphFetch(LIST_AGENTS_QUERY, { first });
        const agents = (data.agents || []).map((a) => ({
          ensName: a.ensName,
          score: a.score,
          tier: scoreTier(a.score),
          humanBacked: a.humanBacked,
          frozen: a.frozen,
          totalTx: a.totalTx,
          defaultTx: a.defaultTx,
          spendLimitWei: a.spendLimitWei,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ count: agents.length, agents }, null, 2) }],
        };
      } catch (error) {
        return toolError("Could not list agents.", "Check GRAPH_ENDPOINT and that the subgraph has indexed agents.");
      }
    }
  );

  // ---------------------------------------------------------------------
  // Resource: credence://agent/{controller} — the report as a JSON resource
  // ---------------------------------------------------------------------
  server.registerResource(
    "agent-credit-report",
    new ResourceTemplate("credence://agent/{controller}", { list: undefined }),
    { title: "Agent credit report", description: "Live on-chain credit report for an agent (JSON).", mimeType: "application/json" },
    async (uri, variables) => {
      const controller = await resolveController(variables.controller);
      const report = await analyzeAgent(controller);
      report.agent.controller = controller;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summarizeReport(report), null, 2),
          },
        ],
      };
    }
  );

  // ---------------------------------------------------------------------
  // Transport: stdio (works with Claude Desktop, Cursor, Claude Code, any
  // MCP client). No endpoint configured -> warn on stderr but stay alive so
  // tools can report a helpful error instead of the client seeing a crash.
  // ---------------------------------------------------------------------
  if (!process.env.GRAPH_ENDPOINT && !process.env.VITE_SUBGRAPH_URL) {
    console.error(
      "[credence-mcp] Warning: no GRAPH_ENDPOINT set. Tools will fail until you set it to the live subgraph endpoint."
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[credence-mcp] ${SERVER_NAME} v${SERVER_VERSION} connected (stdio).`);
}

main().catch((error) => {
  console.error("[credence-mcp] Fatal:", error);
  process.exit(1);
});