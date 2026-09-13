/* Temporary probe: dump the official Subgraph MCP's tools + input schemas */
require("dotenv").config({ path: require("node:path").join(__dirname, "..", "..", "..", ".env") });
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const key = process.env.GRAPH_API_KEY;
const url = process.env.SUBGRAPH_MCP_URL || "https://subgraphs.mcp.thegraph.com/sse";

(async () => {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "mcp-remote", "--header", `Authorization:Bearer ${key}`, url],
    env: { ...process.env, AUTH_HEADER: `Bearer ${key}` },
    stderr: "pipe",
  });
  const client = new Client({ name: "probe", version: "0.0.1" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const t of tools) {
    console.log("### TOOL:", t.name);
    console.log(JSON.stringify(t.inputSchema || {}, null, 2));
    console.log();
  }
  await client.close().catch(() => {});
  process.exit(0);
})().catch((e) => {
  console.error("PROBE FAILED:", e && e.message ? e.message : e);
  process.exit(1);
});