/**
 * http-server.js — standalone World AgentKit bridge for Credence.
 *
 * Two routes (kept intentionally small; the full backend is backend/server.js):
 *
 *   GET  /world/status?address=0x…   — on-chain AgentBook credential check.
 *         Returns { registered, humanId, address } for the controller. This is
 *         the "is this agent backed by a real human?" read: it queries the
 *         canonical AgentBook contract on World Chain, not a local cache.
 *
 *   POST /world/verify               — verify + push on-chain.
 *         body: { controller, agentkitHeader?, resourceUri? }
 *         - with `agentkitHeader`: cryptographically verify the agent's signed
 *           AgentKit (SIWE) header, resolve the signer to its human ID in
 *           AgentBook, then set the CreditBureau flag.
 *         - without: verify the controller's AgentBook registration directly
 *           (World App proof flow is the prerequisite), then set the flag.
 *
 * Run: node integrations/world/http-server.js   (port from WORLD_VERIFY_PORT)
 */

const http = require("node:http");
const { isAddress } = require("ethers");
require("dotenv").config();
const { checkAgentBookStatus } = require("./agent-provision.js");
const { verifyHumanBacking } = require("./verify-agent.js");

const port = Number(process.env.WORLD_VERIFY_PORT || 8788);

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": process.env.WORLD_VERIFY_ORIGIN || "http://localhost:5173",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error("Body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  // --- GET /world/status?address=0x… — credential check, no transaction ----
  if (request.method === "GET" && url.pathname === "/world/status") {
    const address = url.searchParams.get("address");
    if (!address || !isAddress(address)) return sendJson(response, 400, { error: "A valid ?address= is required." });
    try {
      return sendJson(response, 200, await checkAgentBookStatus(address));
    } catch (error) {
      return sendJson(response, 500, { error: error.message || "World status check failed." });
    }
  }

  if (request.method !== "POST" || url.pathname !== "/world/verify") {
    return sendJson(response, 404, { error: "Not found" });
  }

  try {
    const { controller, agentkitHeader, resourceUri, ensName, autoRegister, writeEnsIdentity } = await readBody(request);
    if (!isAddress(controller)) return sendJson(response, 400, { error: "A valid controller address is required." });

    const result = await verifyHumanBacking(controller, {
      agentkitHeader,
      resourceUri,
      ensName,
      autoRegister: Boolean(autoRegister),
      writeEnsIdentity: Boolean(writeEnsIdentity),
    });
    return sendJson(response, 200, {
      message: `World human backing confirmed for ${controller} (human ${result.humanId}).`,
      ...result,
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || "World verification failed." });
  }
});

server.listen(port, () => {
  console.log(`World AgentKit bridge listening on http://localhost:${port}`);
  console.log(`  GET  /world/status?address=0x…`);
  console.log(`  POST /world/verify`);
});