/* Temporary repro: mimic the exact frontend "Ask" path against the live server */
require("dotenv").config({ path: require("node:path").join(__dirname, "..", "..", "..", ".env") });
const { askSubgraphMcp } = require("./subgraph-mcp-client.js");
const { STANDARD_PROTOCOL_QUERY, STANDARD_PROVIDERS } = require("../graph/standardized-intel.js");

(async () => {
  const controller = process.env.CONTROLLER || "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const prompts = [
    "discover the top subgraphs for the loaded agent",
    // "query the latest standardized protocol intel on The Graph Network",
  ];
  for (const prompt of prompts) {
    console.log("=".repeat(70));
    console.log("PROMPT:", prompt);
    console.log("=".repeat(70));
    const out = await askSubgraphMcp(prompt, {
      controller,
      providers: STANDARD_PROVIDERS,
      query: STANDARD_PROTOCOL_QUERY,
    });
    console.log("ok:", out.ok, "| error:", out.error || "-", "| answer:", out.answer ? "yes" : "null");
    for (const step of out.transcript || []) {
      console.log(`  [${step.step}]`);
      console.log("    " + String(step.detail).slice(0, 500));
    }
  }
  process.exit(0);
})().catch((e) => { console.error("REPRO CRASH:", e && e.message ? e.message : e); process.exit(1); });