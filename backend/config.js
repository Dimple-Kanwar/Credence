const PORT = Number(process.env.BACKEND_PORT || 8787);
const HOST = process.env.BACKEND_HOST || "127.0.0.1";
const ORIGIN = process.env.BACKEND_ORIGIN || "http://localhost:3000";

module.exports = {
  PORT,
  HOST,
  ORIGIN,
  GRAPH_ENDPOINT: process.env.GRAPH_ENDPOINT || process.env.VITE_SUBGRAPH_URL,
};
