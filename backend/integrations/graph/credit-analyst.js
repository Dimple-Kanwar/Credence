/**
 * Live Graph-powered credit analyst.
 *
 * Usage:
 *   GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/... \
 *   node integrations/graph/credit-analyst.js 0xAgent
 *
 * The analyst reads the deployed subgraph, produces an explainable credit-line
 * recommendation, and can optionally ask an OpenAI-compatible endpoint to
 * turn the evidence into a concise narrative.
 */
require("dotenv").config();
const { isAddress } = require("ethers");

const QUERY = `
  query AgentCreditReport($id: ID!) {
    agent(id: $id) {
      ensName
      score
      humanBacked
      frozen
      totalTx
      successTx
      lateTx
      disputedTx
      defaultTx
      spendLimitWei
      outcomes(orderBy: timestamp, orderDirection: desc, first: 20) {
        outcomeType
        amountWei
        timestamp
      }
      scoreHistory(orderBy: timestamp, orderDirection: desc, first: 5) {
        oldScore
        newScore
        timestamp
      }
    }
  }
`;

function recommendationFor(agent) {
  const cleanRate = agent.totalTx === 0 ? 0 : agent.successTx / agent.totalTx;
  const recentDefaults = agent.outcomes.filter((item) => item.outcomeType === "Default").length;
  let recommendedLimitWei = BigInt(agent.spendLimitWei);
  let decision = "review";

  if (agent.frozen || recentDefaults > 0 || agent.defaultTx > 0) {
    recommendedLimitWei = 0n;
    decision = "decline";
  } else if (agent.humanBacked && agent.score >= 800 && cleanRate >= 0.9) {
    recommendedLimitWei *= 2n;
    decision = "approve";
  } else if (agent.score >= 650 && cleanRate >= 0.75) {
    decision = "approve-with-monitoring";
  }

  return {
    decision,
    recommendedLimitWei: recommendedLimitWei.toString(),
    cleanRate,
    evidence: [
      `Score ${agent.score}/1000`,
      `${agent.successTx}/${agent.totalTx} successful outcomes`,
      agent.humanBacked ? "World-backed identity signal present" : "No human-backing signal",
      agent.frozen ? "Agent is frozen" : "Agent is active",
    ],
  };
}

async function queryGraph(endpoint, id) {
  const normalized = id.toLowerCase();
  console.log(`Querying Graph endpoint ${endpoint} for agent ${normalized}...`);
  if (!isAddress(id)) {
    throw new Error(
      `Invalid controller address: "${id}". Use a real 0x address from a registered agent, not a placeholder like 0xAgentController.`
    );
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.GRAPH_API_KEY ? { Authorization: `Bearer ${process.env.GRAPH_API_KEY}` } : {}),
    },
    body: JSON.stringify({ query: QUERY, variables: { id: normalized } }),
  });
  if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
  const payload = await response.json();
  console.log(`Graph query returned:`, payload);
  if (payload.errors?.length) throw new Error(payload.errors[0].message);
  if (!payload.data?.agent) {
    throw new Error(
      `No indexed agent found for ${id}. Check that the agent was registered on-chain, the subgraph has synced, and the deployed bureau address matches the active subgraph config.`
    );
  }
  return payload.data.agent;
}

async function explainWithModel(agent, recommendation) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const response = await fetch(process.env.AI_MODEL_URL || "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: process.env.AI_MODEL || "gpt-4o-mini",
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are an underwriting analyst. Use only the supplied on-chain evidence. Never invent facts." },
        { role: "user", content: JSON.stringify({ agent, recommendation }) },
      ],
    }),
  });
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "AI model rate-limited or quota exhausted (HTTP 429) — unset OPENAI_API_KEY (or switch AI_MODEL_URL/AI_MODEL) to use the deterministic evidence-backed recommendation without an LLM."
      );
    }
    throw new Error(`AI model request failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || null;
}

async function analyzeAgent(id) {
  const endpoint = process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL;
  if (!endpoint) throw new Error("Set GRAPH_ENDPOINT to a live Graph provider endpoint");
  const agent = await queryGraph(endpoint, id);
  const recommendation = recommendationFor(agent);
  // The LLM narrative is an optional cosmetics leg: the evidence-backed
  // recommendation is deterministic and standalone, so a model outage (429
  // rate limit, exhausted quota, network error) must never fail the report.
  // This is the same contract the frontend already uses, and it also protects
  // the MCP server and the backend /api/report which call analyzeAgent().
  let narrative = null;
  try {
    narrative = await explainWithModel(agent, recommendation);
  } catch (error) {
    console.warn(`[credit-analyst] AI narrative skipped (${error.message}); returning the deterministic recommendation.`);
  }
  return { agent, recommendation, narrative };
}

if (require.main === module) {
  const [id] = process.argv.slice(2);
  if (!id) {
    console.error("Usage: node integrations/graph/credit-analyst.js <agentController>");
    process.exit(1);
  }
  analyzeAgent(id)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { analyzeAgent, recommendationFor };
