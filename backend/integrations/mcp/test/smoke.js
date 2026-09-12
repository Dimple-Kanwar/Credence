/**
 * smoke.js — end-to-end MCP smoke test, no network required.
 *
 * Spins up a local mock The Graph endpoint, launches server.js as a real
 * MCP server over stdio, and exercises every tool plus the resource read:
 *
 *   node test/smoke.js
 *
 * Covers:
 *   - tools/list reports the expected 4 tools
 *   - get_agent_report returns the evidence-backed recommendation
 *   - get_factoring_rate prices the score -> Hedera discount
 *   - list_agents returns the ranked credit universe
 *   - pay_for_credit_report explains the x402 flow when the service is
 *     not configured (no-network path)
 *   - credence://agent/{controller} resource read
 */
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const http = require("node:http");
const path = require("node:path");

const SERVER_PATH = path.join(__dirname, "..", "server.js");

// ---------------------------------------------------------------------------
// Mock subgraph: serves fixtures for the two query shapes the server sends.
// ---------------------------------------------------------------------------
const FIXTURE_AGENT = {
  ensName: "trader.agentcreditbureau.eth",
  score: 862,
  humanBacked: true,
  frozen: false,
  totalTx: 210,
  successTx: 200,
  lateTx: 8,
  disputedTx: 2,
  defaultTx: 0,
  spendLimitWei: "250000000000000000",
  outcomes: [
    { outcomeType: "Success", amountWei: "1500000000000000", timestamp: "1760000000" },
    { outcomeType: "Late", amountWei: "1200000000000000", timestamp: "1759000000" },
  ],
  scoreHistory: [{ oldScore: 500, newScore: 862, timestamp: "1750000000" }],
};

const FIXTURE_AGENTS = [
  { ensName: "trader.agentcreditbureau.eth", score: 862, humanBacked: true, frozen: false, totalTx: 210, defaultTx: 0, spendLimitWei: "250000000000000000", updatedAt: "1760001000" },
  { ensName: "trader2.agentcreditbureau.eth", score: 452, humanBacked: false, frozen: true, totalTx: 9, defaultTx: 1, spendLimitWei: "0", updatedAt: "1760002000" },
];

const mockServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    try {
      const { query } = JSON.parse(body);
      if (query.includes("AgentCreditReport")) {
        res.end(JSON.stringify({ data: { agent: FIXTURE_AGENT } }));
      } else if (query.includes("ListAgents")) {
        res.end(JSON.stringify({ data: { agents: FIXTURE_AGENTS } }));
      } else {
        res.end(JSON.stringify({ errors: [{ message: "unknown query shape in smoke test" }] }));
      }
    } catch {
      res.end(JSON.stringify({ errors: [{ message: "bad request in smoke test" }] }));
    }
  });
});

function assert(condition, message) {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`);
}

async function main() {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const port = mockServer.address().port;
  const mockUrl = `http://127.0.0.1:${port}`;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, GRAPH_ENDPOINT: mockUrl },
  });

  const client = new Client({ name: "smoke-client", version: "1.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert(
      JSON.stringify(names) ===
        JSON.stringify(["get_agent_report", "get_factoring_rate", "list_agents", "pay_for_credit_report"]),
      `unexpected tools: ${names}`
    );

    const report = await client.callTool({
      name: "get_agent_report",
      arguments: { controller: "0xf00d00000000000000000000000000000000000f" },
    });
    const reportJson = JSON.parse(report.content[0].text);
    assert(reportJson.score === 862, "report score mismatch");
    assert(reportJson.recommendation.decision === "approve", "recommendation decision mismatch");
    assert(reportJson.recommendation.recommendedLimitWei === "500000000000000000", "limit-doubling recommendation mismatch");

    const factoring = await client.callTool({
      name: "get_factoring_rate",
      arguments: { controller: "0xf00d00000000000000000000000000000000000f", faceValueUsd: 1000 },
    });
    const factoringJson = JSON.parse(factoring.content[0].text);
    assert(factoringJson.eligible === true, "factoring should be eligible");
    assert(factoringJson.discountRate === 0.03, `expected 0.03 discount, got ${factoringJson.discountRate}`);
    assert(factoringJson.pricedSaleUsd === 970, `expected priced sale 970, got ${factoringJson.pricedSaleUsd}`);

    const listed = await client.callTool({ name: "list_agents", arguments: { first: 10 } });
    const listedJson = JSON.parse(listed.content[0].text);
    assert(listedJson.count === 2, "list_agents count mismatch");
    assert(listedJson.agents[0].score === 862, "list_agents ranking mismatch");

    const resource = await client.readResource({ uri: "credence://agent/0xf00d00000000000000000000000000000000000f" });
    const resourceJson = JSON.parse(resource.contents[0].text);
    assert(resourceJson.ensName === "trader.agentcreditbureau.eth", "resource ensName mismatch");

    // ENS-name input without resolution env -> helpful error, not a crash.
    const nameCall = await client.callTool({
      name: "get_agent_report",
      arguments: { controller: "trader.agentcreditbureau.eth" },
    });
    assert(nameCall.isError === true, "name input should return isError when resolution env is missing");
    assert(nameCall.content[0].text.includes("SEPOLIA_RPC_URL"), "name resolution error should name the missing env");

    // pay_for_credit_report without X402_SERVER_URL -> helpful no-network reply.
    const paid = await client.callTool({
      name: "pay_for_credit_report",
      arguments: { controller: "0xf00d00000000000000000000000000000000000f" },
    });
    assert(!paid.isError, "pay_for_credit_report should not fail hard without config");
    assert(
      paid.content[0].text.includes("x402 service is not configured"),
      "pay_for_credit_report should explain how to configure the x402 service"
    );

    console.log("SMOKE OK — 4 tools + resource verified against the live server protocol.");
  } finally {
    await client.close();
    mockServer.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});