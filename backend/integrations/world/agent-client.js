/**
 * agent-client.js — Credence agent-side World AgentKit client.
 *
 * The World AgentKit story, from the agent's own wallet: an AI agent signs an
 * `agentkit` header with the SAME wallet that was registered in AgentBook
 * (through the World App proof flow), then calls Credence's API. The backend
 * verifies the SIWE message and resolves the signer to its anonymous human ID
 * on the canonical World Chain AgentBook contract. A bot (unregistered signer,
 * or no valid header) is denied. This is the "distinguish a bot from an agent
 * acting on behalf of a real, unique human" use case the prize asks for.
 *
 * Docs: https://docs.world.org/agents/agent-kit/integrate (Step 3)
 *
 * Usage:
 *   node agent-client.js gate 0x<agent-controller> [gateUrl]
 *       -> sign an agentkit header with the agent wallet (AGENT_PRIVATE_KEY or
 *          CONTROLLER_PRIVATE_KEY in .env), POST it to the backend's
 *          /api/world/gate, print granted humanId (or denial).
 *   node agent-client.js report 0x<agent-controller> [backendUrl]
 *       -> fetch a gated credit report with a signed agentkit header.
 */

const { ethers } = require("ethers");
const {
  createAgentkitClient,
  declareAgentkitExtension,
} = require("@worldcoin/agentkit");
require("dotenv").config();

const DEFAULT_GATE_URL = process.env.WORLD_GATE_URL || "http://127.0.0.1:8787/api/world/gate";
const DEFAULT_BACKEND = process.env.BACKEND_URL || "http://127.0.0.1:8787";
// World Chain (eip155:480) — the canonical chain AgentBook lives on; the
// caller side is chain-agnostic but this is the reference network.
const AGENT_CHAIN_ID = process.env.WORLD_CHAIN_ID || "eip155:480";

function walletForKey() {
  const key = process.env.AGENT_PRIVATE_KEY || process.env.CONTROLLER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!key) throw new Error("Set AGENT_PRIVATE_KEY / CONTROLLER_PRIVATE_KEY in .env to act as an agent.");
  return new ethers.Wallet(key);
}

/**
 * Build a signed `agentkit` header for a protected resource using the agent's
 * own wallet — the same wallet its human registered in AgentBook.
 *
 * declareAgentkitExtension() leaves nonce/issuedAt out (the SDK's server-side
 * extension mints them), but viem's SIWE requires them and the backend's
 * validateAgentkitMessage caps freshness at 5 minutes — so a fresh claim is
 * attached before signing.
 */
async function buildAgentkitHeader(resourceUri, statement) {
  const wallet = walletForKey();
  const issuedAt = new Date();
  const nonceBytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(nonceBytes);
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const declarations = declareAgentkitExtension({
    domain: new URL(resourceUri).hostname,
    resourceUri,
    statement: statement || "Credence: prove this agent is backed by a unique real human",
    network: AGENT_CHAIN_ID,
    mode: { type: "free" },
  });
  const agentkit = declarations.agentkit;
  agentkit.info = {
    ...agentkit.info,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 300_000).toISOString(),
  };
  const client = createAgentkitClient({
    signer: {
      address: wallet.address,
      chainId: AGENT_CHAIN_ID,
      type: "eip191",
      signMessage: (message) => wallet.signMessage(message),
    },
  });
  const header = await client.createHeader(agentkit);
  return { header, address: wallet.address };
}

async function gate(controller, gateUrl = DEFAULT_GATE_URL) {
  const { header, address } = await buildAgentkitHeader(gateUrl, "Credence credit-report gate");
  console.log(`Agent signer: ${address}`);
  console.log(`Presenting signed agentkit header -> ${gateUrl}\n`);

  const response = await fetch(gateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentkitHeader: header, resourceUri: gateUrl, controller }),
  });
  const payload = await response.json().catch(() => ({}));
  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(payload, null, 2));

  if (response.ok && payload.allowed) {
    console.log(`\n✓ ACCESS GRANTED — agent ${payload.address} is backed by human ${payload.humanId}.`);
  } else {
    console.log(`\n✗ ACCESS DENIED — ${payload.error || "not a human-backed agent."} (bots are blocked.)`);
  }
  return payload;
}

async function report(controller, backendUrl = DEFAULT_BACKEND) {
  const url = `${backendUrl}/api/report`;
  const { header } = await buildAgentkitHeader(url, "Credence gated credit report");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ controller, agentkitHeader: header, resourceUri: url }),
  });
  const payload = await response.json();
  console.log(`HTTP ${response.status}`);
  if (response.ok) {
    console.log(`Gated credit report for ${controller} (agentkit verified):`);
    console.log(JSON.stringify({ ...payload, narrative: undefined }, null, 2));
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
  return payload;
}

if (require.main === module) {
  const [command, controller, third] = process.argv.slice(2);
  if (command === "gate") {
    gate(controller, third).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  } else if (command === "report") {
    report(controller, third).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  } else {
    console.error("Usage: node agent-client.js <gate|report> <0xController> [gateUrl|backendUrl]");
    process.exit(1);
  }
}

module.exports = { buildAgentkitHeader, gate, report };