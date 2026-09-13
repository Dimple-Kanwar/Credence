const PORT = Number(process.env.BACKEND_PORT || 8787);
const HOST = process.env.BACKEND_HOST || "127.0.0.1";
const ORIGIN = process.env.BACKEND_ORIGIN || "http://localhost:3000";

module.exports = {
  PORT,
  HOST,
  ORIGIN,
  GRAPH_ENDPOINT: process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL,
  GRAPH_API_KEY: process.env.GRAPH_API_KEY || "",
  GRAPH_STANDARD_ENDPOINTS: process.env.GRAPH_STANDARD_ENDPOINTS || "",
  SUBGRAPH_MCP_URL: process.env.SUBGRAPH_MCP_URL || "https://subgraphs.mcp.thegraph.com/sse",
};
