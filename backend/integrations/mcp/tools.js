const { isAddress, ZeroAddress, JsonRpcProvider, Contract } = require("ethers");
const { analyzeAgent } = require("../graph/credit-analyst.js");

const LIST_AGENTS_QUERY = `
  query ListAgents($first: Int!) {
    agents(orderBy: score, orderDirection: desc, first: $first) {
      ensName score humanBacked frozen totalTx defaultTx spendLimitWei updatedAt
    }
  }
`;

const RESOLVE_ABI = ["function resolveByEnsName(string ensName) external view returns (address)"];

function scoreTier(score) {
  if (score >= 900) return "Prime";
  if (score >= 800) return "Established";
  if (score >= 650) return "Building";
  if (score >= 500) return "New";
  return "Restricted";
}

function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null;
}

function summarizeReport({ agent, recommendation, narrative }, controller) {
  return {
    ensName: agent.ensName,
    controller,
    score: agent.score,
    tier: scoreTier(Number(agent.score)),
    humanBacked: agent.humanBacked,
    frozen: agent.frozen,
    totalTx: agent.totalTx,
    successTx: agent.successTx,
    lateTx: agent.lateTx,
    disputedTx: agent.disputedTx,
    defaultTx: agent.defaultTx,
    spendLimitWei: agent.spendLimitWei,
    latestOutcomes: (agent.outcomes || []).slice(0, 10).map((outcome) => ({
      outcomeType: outcome.outcomeType,
      amountWei: outcome.amountWei,
      timestamp: outcome.timestamp,
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

async function resolveController(input) {
  const value = String(input || "").trim();
  if (isAddress(value)) return value;
  if (!process.env.SEPOLIA_RPC_URL || !process.env.CREDIT_BUREAU_ADDRESS) {
    throw new Error("ENS resolution requires SEPOLIA_RPC_URL and CREDIT_BUREAU_ADDRESS.");
  }
  const provider = new JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const bureau = new Contract(process.env.CREDIT_BUREAU_ADDRESS, RESOLVE_ABI, provider);
  const controller = await bureau.resolveByEnsName(value);
  if (controller === ZeroAddress) throw new Error(`No registered controller found for ${value}.`);
  return controller;
}

async function graphFetch(query, variables) {
  const endpoint = process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL;
  if (!endpoint) throw new Error("Set GRAPH_ENDPOINT or VITE_SUBGRAPH_URL.");
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

async function getAgentReport(controllerInput) {
  const controller = await resolveController(controllerInput);
  const report = await analyzeAgent(controller);
  return summarizeReport(report, controller);
}

async function listAgents(first = 10) {
  const count = Math.min(Math.max(Number(first) || 10, 1), 100);
  const data = await graphFetch(LIST_AGENTS_QUERY, { first: count });
  const agents = (data.agents || []).map((agent) => ({
    ...agent,
    tier: scoreTier(Number(agent.score)),
  }));
  return { count: agents.length, agents };
}

async function getFactoringRate(controllerInput, faceValueUsd) {
  const controller = await resolveController(controllerInput);
  const { agent } = await analyzeAgent(controller);
  const discountRate = agent.frozen ? null : discountRateForScore(Number(agent.score));
  const eligible = !agent.frozen && discountRate !== null;
  const faceValue = Number(faceValueUsd || 0);
  return {
    controller,
    ensName: agent.ensName,
    score: agent.score,
    eligible,
    discountRate: eligible ? discountRate : null,
    discountPercent: eligible ? discountRate * 100 : null,
    faceValueUsd: faceValue > 0 ? faceValue : null,
    pricedSaleUsd: eligible && faceValue > 0 ? Number((faceValue * (1 - discountRate)).toFixed(2)) : null,
    note: agent.frozen
      ? "Agent is frozen; receivables are not eligible."
      : eligible
        ? "Eligible for Hedera receivable tokenization."
        : "Score below the 500 factoring threshold.",
  };
}

async function answerChat(message) {
  const text = String(message || "").trim();
  const subject = text.match(/0x[a-fA-F0-9]{40}/)?.[0] || text.match(/[a-z0-9-]+\.agentcreditbureau\.eth/i)?.[0];
  if (/list|rank|top|leaderboard/i.test(text)) return { tool: "list_agents", result: await listAgents(10) };
  if (/factor|invoice|receivable|discount/i.test(text) && subject) {
    return { tool: "get_factoring_rate", result: await getFactoringRate(subject) };
  }
  if (subject) return { tool: "get_agent_report", result: await getAgentReport(subject) };
  return {
    tool: null,
    result: "I can query get_agent_report, get_factoring_rate, or list_agents. Include a controller address or ENS name for an agent-specific request.",
  };
}

module.exports = {
  LIST_AGENTS_QUERY,
  answerChat,
  discountRateForScore,
  getAgentReport,
  getFactoringRate,
  graphFetch,
  listAgents,
  resolveController,
  scoreTier,
  summarizeReport,
};
