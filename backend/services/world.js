const { ethers } = require("ethers");
const {
  checkAgentBookStatus,
  registerInAgentBook,
  verifyAgentkitProof,
  worldAppVerifyUrl,
  isAgentBookSandbox,
} = require("../integrations/world/agent-provision.js");
const { verifyHumanBacking } = require("../integrations/world/verify-agent.js");
const {
  getSelfieCheckStatus,
  isSelfieConfigured,
  signSelfieRequest,
  verifySelfieProof,
} = require("../integrations/world/selfie-check.js");
const { resolveController } = require("./mcp.js");

/**
 * Register the agent's controller wallet in the World AgentBook FIRST (before
 * any ENS contract is called) — the agent-kit integrate guide step 2
 * (`npx @worldcoin/agentkit-cli register <address>`). The caller uses the
 * result to decide the `humanBacked` flag for the ENS/bureau mint:
 *
 *   registration succeeded -> humanBacked = true
 *   registration failed    -> humanBacked = false
 *
 * This project runs on the World ID SANDBOX (WORLD_ID_ENVIRONMENT=staging):
 * registration writes to the labeled in-memory/file-backed sandbox AgentBook
 * (`mock: true, environment: "sandbox"`) — no production World Chain
 * transaction and never production identities. Production AgentBook is
 * hard-disabled unless WORLD_ALLOW_PRODUCTION=1 is set explicitly.
 */
async function registerAgentBook(address) {
  const controller = ethers.isAddress(String(address || "").trim())
    ? ethers.getAddress(String(address).trim())
    : String(address || "").trim();
  if (!controller) throw new Error("A controller address (or ENS name) is required.");

  // --- sandbox (this project's default): register in the sandbox AgentBook ---
  if (isAgentBookSandbox()) {
    const res = await registerInAgentBook(controller);
    return {
      registered: res.registered,
      humanId: res.humanId || null,
      address: controller,
      mock: true,
      environment: "sandbox",
      alreadyRegistered: Boolean(res.alreadyRegistered),
      message:
        res.message ||
        `Sandbox AgentBook registration — mock human ${res.humanId} backs ${controller} (no production World ID was used).`,
      verifyUrl: worldAppVerifyUrl(controller),
    };
  }

  // --- production (explicit WORLD_ALLOW_PRODUCTION=1 only) ---
  // Already registered? Nothing to do — report it as a soft success.
  const existing = await checkAgentBookStatus(controller).catch(() => ({ registered: false }));
  if (existing.registered) {
    return {
      registered: true,
      humanId: existing.humanId,
      address: controller,
      mock: false,
      environment: "production",
      alreadyRegistered: true,
      message: `Already registered in AgentBook — human ${existing.humanId} backs ${controller}.`,
    };
  }

  // Real flow: run the AgentKit CLI (interactive World App proof), then
  // confirm the on-chain AgentBook entry.
  const res = await registerInAgentBook(controller);
  const after = await checkAgentBookStatus(controller).catch(() => null);
  if (after?.registered) {
    return {
      registered: true,
      humanId: after.humanId,
      address: controller,
      mock: false,
      environment: "production",
      cli: res.stdout,
      message: `Registered in AgentBook — human ${after.humanId} backs ${controller}.`,
    };
  }
  return {
    registered: false,
    address: controller,
    mock: false,
    environment: "production",
    cli: res.stdout,
    error: "AgentBook is still not registered after the CLI proof flow.",
    verifyUrl: worldAppVerifyUrl(controller),
    message: "AgentBook registration did not complete — the ENS identity will be minted with humanBacked=false.",
  };
}

async function status(payload) {
  const address = payload.address ? await resolveController(payload.address) : null;
  if (!address) throw new Error("A controller address or ENS name is required.");
  const result = await checkAgentBookStatus(address);
  result.selfieCheck = getSelfieCheckStatus(address);
  result.selfieCheckConfigured = isSelfieConfigured();
  return result;
}

async function signSelfie(payload) {
  return signSelfieRequest(payload.controller);
}

async function verifySelfie(payload) {
  const result = await verifySelfieProof({
    controller: payload.controller,
    rp_id: payload.rp_id,
    idkitResponse: payload.idkitResponse,
    pushOnChain: payload.pushOnChain !== false,
    ensName: payload.ensName,
  });
  return {
    message: `Selfie Check credential recorded for ${result.controller} (${result.environment}).`,
    ...result,
  };
}

async function gate(payload, request) {
  const resourceUri = payload.resourceUri || `http://${request.headers.host}/api/world/gate`;
  const result = await verifyAgentkitProof({
    header: payload.agentkitHeader,
    resourceUri,
    rpcUrl: payload.rpcUrl || process.env.WORLD_CHAIN_RPC_URL,
  });
  return {
    statusCode: result.valid && result.humanId ? 200 : 403,
    allowed: Boolean(result.valid && result.humanId),
    address: result.address || null,
    humanId: result.humanId || null,
    error: result.error || null,
    message: result.humanId
      ? `Agent ${result.address} is backed by human ${result.humanId} — access granted.`
      : "Access denied: not a human-backed agent.",
  };
}

async function verify(payload, request) {
  const controller = await resolveController(payload.controller);
  await verifyHumanBacking(controller, {
    agentkitHeader: payload.agentkitHeader,
    resourceUri: payload.resourceUri,
    ensName: payload.controller.includes(".") ? payload.controller : undefined,
    writeEnsIdentity: Boolean(payload.writeEnsIdentity),
  });
  return { message: `World human backing confirmed for ${controller}.` };
}

module.exports = { gate, registerAgentBook, signSelfie, status, verify, verifySelfie };
