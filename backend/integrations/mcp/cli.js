/**
 * cli.js — run the Credence MCP tools from a script, no MCP client needed.
 *
 * The Graph/MCP track prizes "AI tooling over The Graph's data": the same
 * three tools the MCP server exposes to Claude/Cursor/agent SDKs (
 * integrations/mcp/server.js) are callable directly from a terminal or a
 * cron/CI job. The output JSON is byte-for-byte the same shape an MCP
 * client receives, so a script can stand in for (or test) the MCP layer.
 *
 * Usage:
 *   node integrations/mcp/cli.js list_agents [first]
 *   node integrations/mcp/cli.js get_agent_report <controller|ensName>
 *   node integrations/mcp/cli.js get_factoring_rate <controller|ensName> [faceValueUsd]
 *   node integrations/mcp/cli.js get_market_intel [controller|ensName]
 *   node integrations/mcp/cli.js ask_graph_network "<prompt>"
 *   node integrations/mcp/cli.js tools
 *
 * Requires GRAPH_ENDPOINT (or VITE_SUBGRAPH_URL); optionally
 * OPENAI_API_KEY for the narrative leg, SEPOLIA_RPC_URL +
 * CREDIT_BUREAU_ADDRESS to resolve ENSv2 names, GRAPH_API_KEY for the
 * composable legs (standardized intel + official Subgraph MCP).
 */
require("dotenv").config();
const { isAddress, ZeroAddress, JsonRpcProvider, Contract } = require("ethers");
const { analyzeAgent } = require("../graph/credit-analyst.js");

function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null;
}

function scoreTier(score) {
  if (score >= 900) return "Prime";
  if (score >= 800) return "Established";
  if (score >= 650) return "Building";
  if (score >= 500) return "New";
  return "Restricted";
}

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

/** Mirror of server.js summarizeReport() — identical tool output shape. */
function summarizeReport({ agent, recommendation, narrative }, controller) {
  return {
    ensName: agent.ensName,
    controller: controller ?? null,
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

/** Accept 0x… or an ENSv2 name (resolved on-chain, like the MCP server). */
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
  if (controller === ZeroAddress) throw new Error(`No controller is registered for ENS name "${trimmed}".`);
  return controller;
}

async function listAgents(first) {
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
  return { count: agents.length, agents };
}

async function factoringRate(controllerInput, faceValueUsd) {
  const controller = await resolveController(controllerInput);
  const { agent } = await analyzeAgent(controller);
  if (agent.frozen) {
    return `Agent ${agent.ensName || controller} is FROZEN — receivables are NOT eligible for factoring.`;
  }
  const discountRate = discountRateForScore(agent.score);
  const eligible = discountRate !== null;
  const salePrice = eligible && faceValueUsd ? Number((faceValueUsd * (1 - discountRate)).toFixed(2)) : null;
  return {
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
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "tools":
      console.log(
        JSON.stringify(
          [
            { name: "list_agents", args: "[first]" },
            { name: "get_agent_report", args: "<controller|ensName>" },
            { name: "get_factoring_rate", args: "<controller|ensName> [faceValueUsd]" },
            { name: "get_market_intel", args: "[controller|ensName] — Messari standardized subgraphs, one query shape across protocols" },
            { name: "ask_graph_network", args: "\"<prompt>\" — routes to The Graph's official hosted Subgraph MCP" },
            { name: "pay_for_credit_report", args: "<controller|ensName> [report|rate] — Hedera x402, requires the x402 server + payer wallet" },
          ],
          null,
          2
        )
      );
      break;
    case "list_agents": {
      const first = Number(rest[0] || 10);
      console.log(JSON.stringify(await listAgents(first), null, 2));
      break;
    }
    case "get_agent_report": {
      if (!rest[0]) throw new Error("get_agent_report requires <controller|ensName>");
      const controller = await resolveController(rest[0]);
      const report = await analyzeAgent(controller);
      report.agent.controller = controller;
      console.log(JSON.stringify(summarizeReport(report, controller), null, 2));
      break;
    }
    case "get_factoring_rate": {
      if (!rest[0]) throw new Error("get_factoring_rate requires <controller|ensName>");
      const result = await factoringRate(rest[0], rest[1] !== undefined ? Number(rest[1]) : undefined);
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      break;
    }
    case "get_market_intel": {
      const { fetchStandardizedIntel } = require("../graph/standardized-intel.js");
      const controller = rest[0] ? await resolveController(rest[0]) : null;
      console.log(JSON.stringify(await fetchStandardizedIntel(controller), null, 2));
      break;
    }
    case "ask_graph_network": {
      const { askSubgraphMcp } = require("./subgraph-mcp-client.js");
      const { STANDARD_PROTOCOL_QUERY, STANDARD_PROVIDERS } = require("../graph/standardized-intel.js");
      if (!rest[0]) throw new Error("ask_graph_network requires a \"<prompt>\"");
      console.log(
        JSON.stringify(
          await askSubgraphMcp(rest.join(" "), { providers: STANDARD_PROVIDERS, query: STANDARD_PROTOCOL_QUERY }),
          null,
          2
        )
      );
      break;
    }
    case "pay_for_credit_report": {
      // Same x402 flow an MCP agent would run — the CLI is just thin sugar
      // over integrations/hedera/x402/buyer.js.
      const { execFileSync } = require("node:child_process");
      const path = require("node:path");
      const hederaX402Dir = path.join(__dirname, "..", "hedera", "x402");
      const service = rest[1] === "rate" ? "rate" : "report";
      if (!rest[0]) throw new Error("pay_for_credit_report requires <controller|ensName>");
      if (!process.env.X402_SERVER_URL) {
        console.error(
          "x402 service not configured. Start it first: cd integrations/hedera && npm run start:x402\n" +
            "then set X402_SERVER_URL, X402_PAYER_ACCOUNT (testnet HBAR wallet), X402_PAYER_KEY."
        );
        process.exit(1);
      }
      const out = execFileSync(process.execPath, [path.join(hederaX402Dir, "buyer.js"), rest[0], service], {
        env: process.env,
        stdio: "inherit",
        timeout: 120000,
      });
      console.log(String(out));
      break;
    }
    default:
      console.error(
        "Usage: node integrations/mcp/cli.js <tools|list_agents|get_agent_report|get_factoring_rate|get_market_intel|ask_graph_network> [args]"
      );
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});