const {
  answerChat,
  getAgentReport,
  getFactoringRate,
  listAgents,
  resolveController,
  getMarketIntel,
  askGraphNetwork,
} = require("../integrations/mcp/tools.js");
const { graphStackStatus } = require("../integrations/graph/graph-stack.js");

async function report(payload) {
  return getAgentReport(payload.controller);
}

async function askGraphNetworkViaHttp(payload) {
  return askGraphNetwork(payload.prompt, payload.controller);
}

async function gatedReport(payload, request) {
  const { verifyAgentkitProof } = require("../integrations/world/agent-provision.js");
  const resourceUri = payload.resourceUri || `http://${request.headers.host}/api/report`;
  const gate = await verifyAgentkitProof({
    header: payload.agentkitHeader,
    resourceUri,
    rpcUrl: payload.rpcUrl || process.env.WORLD_CHAIN_RPC_URL,
  });
  if (!gate.valid || !gate.humanId) {
    const error = new Error(`AgentKit gate: ${gate.error || "not a human-backed agent."}`);
    error.statusCode = 403;
    throw error;
  }
  const result = await report(payload);
  result.agentkit = { verified: true, address: gate.address, humanId: gate.humanId, mode: "free" };
  return result;
}

module.exports = {
  answerChat,
  askGraphNetwork: askGraphNetworkViaHttp, // wrapper: unpacks { prompt, controller } from the HTTP route
  gatedReport,
  getAgentReport,
  getFactoringRate,
  getMarketIntel,
  graphStackStatus,
  listAgents,
  report,
  resolveController,
};
