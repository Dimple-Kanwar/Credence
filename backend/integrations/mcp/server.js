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
const {
  getAgentReport,
  getFactoringRate,
  listAgents,
} = require("./tools.js");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

const SERVER_NAME = "credence-credit-bureau";
const SERVER_VERSION = "0.1.0";

const toolError = (message, hint) => {
  const text = hint ? `${message}\n${hint}` : message;
  return { content: [{ type: "text", text }], isError: true };
};

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
        const report = await getAgentReport(input);
        return {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
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
        const result = await getFactoringRate(input, faceValueUsd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
        const result = await listAgents(first);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return toolError("Could not list agents.", "Check GRAPH_ENDPOINT and that the subgraph has indexed agents.");
      }
    }
  );

  // ---------------------------------------------------------------------
  // pay_for_credit_report — Hedera x402: the agent pays per report in HBAR
  // via the hosted Blocky402 facilitator (ETHOnline track: "AI & Agentic
  // Payments on Hedera"). No API key, no seats: the agent pays 100 tinybar
  // and gets the same report get_agent_report returns, plus on-ledger
  // payment evidence. When the x402 server / payer wallet are not
  // configured, the tool returns the exact runnable commands instead so an
  // agent can still complete the flow.
  // ---------------------------------------------------------------------
  server.registerTool(
    "pay_for_credit_report",
    {
      title: "Pay for a credit report on Hedera (x402 pay-per-call)",
      description:
        "Pull a live credit report for an agent by PAYING for it per call on Hedera testnet — an HBAR micropayment (100 tinybar) settled through the Blocky402 x402 facilitator. Returns the same report as get_agent_report plus payment evidence (transaction id + HashScan link) proving the agent paid from its own wallet. Requires the Credence x402 service (X402_SERVER_URL) and a funded payer wallet (X402_PAYER_ACCOUNT / X402_PAYER_KEY) in the environment; otherwise returns the exact commands to run them.",
      inputSchema: {
        controller: z
          .string()
          .describe("Agent controller address (0x…) or ENSv2 name, e.g. trader.agentcreditbureau.eth"),
        service: z.enum(["report", "rate"]).optional().describe("Which paid service to call (default report)"),
      },
    },
    async ({ controller: input, service }) => {
      const hederaX402Dir = path.join(__dirname, "..", "hedera", "x402");
      try {
        if (!process.env.X402_SERVER_URL) {
          return {
            content: [
              {
                type: "text",
                text:
                  "The x402 service is not configured, so here is exactly how to run it:\n" +
                  `  cd backend/integrations/hedera && npm run start:x402` +
                  `\n` +
                  `  node x402/buyer.js ${input} ${service === "rate" ? "rate" : "report"}` +
                  `\nEnv needed: X402_SERVER_URL, X402_PAYER_ACCOUNT (testnet wallet with HBAR), X402_PAYER_KEY (see https://portal.hedera.com).`,
              },
            ],
          };
        }
        const { stdout } = await execFileAsync(
          process.execPath,
          [path.join(hederaX402Dir, "buyer.js"), input, service === "rate" ? "rate" : "report"],
          {
            env: {
              ...process.env,
              X402_SERVER_URL: process.env.X402_SERVER_URL,
              X402_PAYER_ACCOUNT: process.env.X402_PAYER_ACCOUNT || "",
              X402_PAYER_KEY: process.env.X402_PAYER_KEY || "",
            },
            timeout: 120000,
          },
        );
        // buyer.js prints the report JSON; surface the whole transcript so
        // the agent can read both the payment evidence and the report.
        return { content: [{ type: "text", text: stdout }] };
      } catch (error) {
        const stderr = error.stderr ? String(error.stderr) : "";
        const stdout = error.stdout ? String(error.stdout) : "";
        return toolError(
          `Paid credit report failed for "${input}".`,
          [stdout.trim(), stderr.trim(), error.message]
            .filter(Boolean)
            .join("\n") +
            "\nTop up the payer wallet at https://portal.hedera.com and retry, and make sure the x402 server is running (npm run start:x402).",
        );
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
      const report = await getAgentReport(variables.controller);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(report, null, 2),
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