const config = require("./config.js");
const { readJsonBody, sendJson, urlPath } = require("./utils/http.js");
const mcp = require("./services/mcp.js");
const world = require("./services/world.js");
const hedera = require("./services/hedera.js");

function routeParam(path, prefix) {
  return decodeURIComponent(path.slice(prefix.length));
}

async function handleRoutes(request, response) {
  const path = urlPath(request);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {}, config.ORIGIN);
    return true;
  }

  try {
    if (request.method === "GET") {
      if (path === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          service: "credence-backend",
          graphConfigured: Boolean(config.GRAPH_ENDPOINT),
        }, config.ORIGIN);
        return true;
      }
      if (path === "/") {
        const x402 = await hedera.service();
        sendJson(response, 200, { service: "credence-backend", x402: x402.serviceIndex() }, config.ORIGIN);
        return true;
      }
      if (path === "/credit-report/health") {
        const x402 = await hedera.service();
        sendJson(response, 200, x402.serviceHealth(), config.ORIGIN);
        return true;
      }
      if (path.startsWith("/credit-report/")) {
        const x402 = await hedera.service();
        const result = await x402.paidCreditReport(routeParam(path, "/credit-report/"), request.headers);
        sendJson(response, result.status, result.body, config.ORIGIN);
        return true;
      }
      if (path.startsWith("/factoring-rate/")) {
        const x402 = await hedera.service();
        const result = await x402.paidFactoringRate(routeParam(path, "/factoring-rate/"), request.headers);
        sendJson(response, result.status, result.body, config.ORIGIN);
        return true;
      }
      if (path === "/api/hedera/status") {
        sendJson(response, 200, await hedera.status(), config.ORIGIN);
        return true;
      }
      sendJson(response, 404, { error: "Route not found." }, config.ORIGIN);
      return true;
    }

    if (request.method !== "POST") {
      sendJson(response, 404, { error: "Route not found." }, config.ORIGIN);
      return true;
    }

    const payload = await readJsonBody(request);

    if (path === "/api/report") {
      const result = payload.agentkitHeader
        ? await mcp.gatedReport(payload, request)
        : await mcp.report(payload);
      sendJson(response, 200, result, config.ORIGIN);
      return true;
    }
    if (path === "/api/agents") {
      sendJson(response, 200, await mcp.listAgents(payload.first), config.ORIGIN);
      return true;
    }
    if (path === "/api/factoring") {
      sendJson(response, 200, await mcp.getFactoringRate(payload.controller, payload.faceValueUsd), config.ORIGIN);
      return true;
    }
    if (path === "/api/chat") {
      sendJson(response, 200, await mcp.answerChat(payload.message), config.ORIGIN);
      return true;
    }
    if (path === "/api/world/status") {
      sendJson(response, 200, await world.status(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/world/register") {
      sendJson(response, 200, await world.registerAgentBook(payload.address || payload.controller), config.ORIGIN);
      return true;
    }
    if (path === "/api/world/selfie/sign") {
      sendJson(response, 200, await world.signSelfie(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/world/selfie/verify") {
      sendJson(response, 200, await world.verifySelfie(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/world/gate") {
      const result = await world.gate(payload, request);
      sendJson(response, result.statusCode, {
        allowed: result.allowed,
        address: result.address,
        humanId: result.humanId,
        error: result.error,
        message: result.message,
      }, config.ORIGIN);
      return true;
    }
    if (path === "/api/world/verify") {
      sendJson(response, 200, await world.verify(payload, request), config.ORIGIN);
      return true;
    }
    if (path === "/api/receivables/tokenize") {
      sendJson(response, 200, await hedera.tokenize(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/x402/report") {
      if (!payload.controller) throw new Error("controller required.");
      sendJson(response, 200, await hedera.payFor("credit-report", payload.controller), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/x402/rate") {
      if (!payload.controller) throw new Error("controller required.");
      sendJson(response, 200, await hedera.payFor("factoring-rate", payload.controller), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/quote") {
      if (!payload.controller) throw new Error("controller required.");
      sendJson(response, 200, await hedera.quote(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/transfer") {
      sendJson(response, 200, await hedera.transfer(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/schedule") {
      sendJson(response, 200, await hedera.schedule(payload), config.ORIGIN);
      return true;
    }
    if (path === "/api/hedera/redeem") {
      sendJson(response, 200, await hedera.redeem(payload), config.ORIGIN);
      return true;
    }

    sendJson(response, 404, { error: "Route not found." }, config.ORIGIN);
    return true;
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message || "Backend request failed." }, config.ORIGIN);
    return true;
  }
}

module.exports = { handleRoutes };
