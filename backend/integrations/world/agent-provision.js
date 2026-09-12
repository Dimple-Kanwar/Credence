/**
 * agent-provision.js — World AgentKit identity provisioning for Credence.
 *
 * Turns "human-backed" from a checkbox into a credential verified against the
 * canonical AgentBook registry on World Chain. The AgentBook contract is the
 * ground truth for "a unique real human stands behind this wallet": the World
 * App proof flow (orb/device/NFC-verified unique personhood — real
 * credentials) registers the agent's wallet on-chain, and this module resolves
 * that wallet to its anonymous human identifier.
 *
 * Docs: https://docs.world.org/agents/agent-kit/integrate
 *       https://docs.world.org/agents/agent-kit/sdk-reference
 * Repo: https://github.com/worldcoin/agentkit
 *
 * API surface (all exported by @worldcoin/agentkit v0.2.x):
 *   - createAgentBookVerifier()          -> lookupHuman(address) => humanId|null
 *   - parseAgentkitHeader / validateAgentkitMessage / verifyAgentkitSignature
 *   - createAgentkitClient()             (agent-side; signs `agentkit` headers)
 *
 * Three layers:
 *   1. STATUS — cheap on-chain AgentBook lookups (no proof, no wallet).
 *   2. PROOF  — cryptographic verification of a signed `agentkit` header the
 *               agent presents (SIWE message binding + signature + AgentBook).
 *   3. PROVISION — writes the verified World identity into the agent's ENS
 *               identity records and pushes the flag on-chain to CreditBureau.
 */

const { ethers } = require("ethers");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const {
  createAgentBookVerifier,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
} = require("@worldcoin/agentkit");
const {
  isAgentBookSandbox,
  assertSandboxOnly,
  sandboxRegister,
  sandboxLookup,
  sandboxStatus,
} = require("./agentbook-sandbox.js");

const execFileAsync = promisify(execFile);

// Canonical AgentBook deployment on World Chain (docs.world.org/agents/agent-kit).
// Every lookup resolves here regardless of which chain the agent operates on.
const AGENT_BOOK_ADDRESS = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";

/**
 * ENS text-record keys under which the World identity is stored as part of the
 * agent's ENSv2 identity (written by the controller wallet, which holds ALL
 * roles on its own Permissioned Resolver — no EAC grant needed).
 * `environment` records whether the credential came from the World ID SANDBOX
 * (this project's default) or from a production World Chain AgentBook — ENS
 * names minted on the sandbox are self-describing, never mistaken for real
 * World Chain registrations.
 */
const WORLD_IDENTITY_TEXT_KEYS = {
  backed: "world.agentbook.backed",
  humanId: "world.agentbook.human-id",
  lookup: "world.agentbook.lookup",
  timestamp: "world.agentbook.timestamp",
  environment: "world.agentbook.environment",
  mock: "world.agentbook.mock",
};

/* ------------------------------------------------------------------ */
/* 1. STATUS — on-chain AgentBook lookups (credential checks)          */
/* ------------------------------------------------------------------ */

/**
 * Check whether a wallet address is registered in the AgentBook registry.
 *
 * SANDBOX MODE (this project's default — WORLD_ID_ENVIRONMENT=staging):
 * resolves against the local sandbox AgentBook only. No production World
 * Chain call is ever made, and every result is labeled
 * `mock: true, environment: "sandbox"`.
 *
 * PRODUCTION MODE (explicit WORLD_ID_ENVIRONMENT=production +
 * WORLD_ALLOW_PRODUCTION=1): reads the canonical World Chain contract via
 * `createAgentBookVerifier().lookupHuman`.
 *
 * @param {string} address agent controller/operator wallet
 * @param {object} [options] { rpcUrl?, contractAddress? }
 * @returns {Promise<{registered: boolean, humanId: string|null, address: string, mock?: boolean, environment?: string}>}
 */
async function checkAgentBookStatus(address, options = {}) {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid agent address: ${address}`);
  }
  if (isAgentBookSandbox()) {
    // Sandbox lookups never touch the production World Chain AgentBook.
    return sandboxStatus(address);
  }
  assertSandboxOnly();
  const verifier = createAgentBookVerifier({
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
    ...(options.contractAddress ? { contractAddress: options.contractAddress } : {}),
  });
  const humanId = await verifier.lookupHuman(address);
  return {
    registered: Boolean(humanId),
    humanId,
    address: ethers.getAddress(address),
    mock: false,
    environment: "production",
  };
}

/**
 * URL that opens the World App verification flow for a given signal (the agent
 * controller address). The World App runs the unique-personhood proof against
 * real credentials, then AgentBook registration lands on World Chain. Works
 * when the World App / dev-portal app is configured for agents; the maintained
 * fallback is the agentkit CLI (`registerInAgentBook`).
 */
function worldAppVerifyUrl(signal, appId = process.env.WORLD_APP_ID || "") {
  const base = "https://worldcoin.org/verify";
  const params = new URLSearchParams();
  if (appId) params.set("app_id", appId);
  params.set("signal", signal);
  return `${base}?${params.toString()}`;
}

/**
 * Register the agent controller in AgentBook — THE step that must run BEFORE
 * any ENS contract when minting an agent identity (agent-kit integrate guide
 * step 2: `npx @worldcoin/agentkit-cli register <address>`).
 *
 * SANDBOX MODE (this project's default): writes to the local sandbox
 * AgentBook and returns a labeled mock credential — no World App proof, no
 * production World Chain transaction. Idempotent: re-registering returns
 * `alreadyRegistered: true` with the same mock human id.
 *
 * PRODUCTION MODE (explicit opt-in only): runs the maintained CLI, which
 * prompts the World App proof flow and submits the registration transaction
 * to World Chain. Interactive — run it from a terminal, or deep-link the
 * World App from the browser instead.
 * @returns {Promise<{registered: boolean, humanId?: string|null, stdout?: string, address: string, mock?: boolean, environment?: string, alreadyRegistered?: boolean}>}
 */
async function registerInAgentBook(address) {
  if (!ethers.isAddress(address)) throw new Error(`Invalid agent address: ${address}`);
  if (isAgentBookSandbox()) {
    return sandboxRegister(address);
  }
  assertSandboxOnly();
  const { stdout, stderr } = await execFileAsync(
    process.env.WORLD_AGENTKIT_CLI || "npx",
    ["--yes", "@worldcoin/agentkit-cli", "register", address],
    { env: process.env, timeout: 120_000 }
  );
  return { registered: false, stdout: stdout + (stderr || ""), address };
}

/* ------------------------------------------------------------------ */
/* 2. PROOF — verify a signed `agentkit` header (SIWE message)        */
/* ------------------------------------------------------------------ */

/**
 * Fully verify the `agentkit` header an agent presents, following the SDK
 * reference "manual usage" flow:
 *   parseAgentkitHeader -> validate (freshness/binding) -> verify signature
 *   -> resolve the signer to its human ID in AgentBook.
 * @param {string} header  base64-encoded `agentkit` HTTP header (the agent
 *   side produces it with createAgentkitClient().createHeader(extension)).
 * @param {string} resourceUri the protected resource the header claims to
 *   access (e.g. the report URL) — must match what was signed.
 * @param {object} [options] { rpcUrl? }
 * @returns {Promise<{valid: boolean, address?: string, humanId?: string|null, error?: string}>}
 */
async function verifyAgentkitProof({ header, resourceUri, rpcUrl }) {
  if (!header) return { valid: false, error: "No AgentKit header provided" };
  let payload;
  try {
    payload = parseAgentkitHeader(header);
  } catch (error) {
    return { valid: false, error: `AgentKit header does not parse: ${error.message}` };
  }
  const validation = await validateAgentkitMessage(payload, resourceUri);
  if (!validation.valid) return { valid: false, error: validation.error || "Message validation failed" };

  const verification = await verifyAgentkitSignature(payload, rpcUrl);
  if (!verification.valid || !verification.address) {
    return { valid: false, error: verification.error || "Signature verification failed" };
  }
  // Sanbox mode: resolve the signer against the local sandbox AgentBook
  // (signature verification itself is chain-independent EIP-191 recovery).
  const status = isAgentBookSandbox()
    ? await sandboxLookup(verification.address)
    : await checkAgentBookStatus(verification.address, { rpcUrl });
  if (!status || !status.registered) {
    return {
      valid: true,
      address: verification.address,
      humanId: null,
      error: "Agent is not registered in the AgentBook",
    };
  }
  return { valid: true, address: verification.address, humanId: status.humanId };
}

/* ------------------------------------------------------------------ */
/* 3. PROVISION — World identity as part of the ENS identity          */
/* ------------------------------------------------------------------ */

/** DNS-encode a name (RFC 1035) — required by ENSv2 resolver setters. */
function dnsEncode(name) {
  const labels = name.split(".");
  const parts = labels.map((label) => {
    const bytes = ethers.toUtf8Bytes(label);
    return ethers.concat([Uint8Array.of(bytes.length), bytes]);
  });
  return ethers.concat([...parts, Uint8Array.of(0)]);
}

/**
 * Write the verified World identity into the agent's own ENSv2 Permissioned
 * Resolver text records, binding the human ID to the ENS name. The controller
 * wallet (which holds ALL_ROLES on its own resolver) signs these writes, so
 * this is the "World identity registered as part of the agent identity" step.
 *
 * Records written:
 *   world.agentbook.backed    = "true" | "false"
 *   world.agentbook.human-id  = 0x-hex human id from AgentBook
 *   world.agentbook.lookup    = canonical AgentBook contract address
 *   world.agentbook.timestamp = ISO8601 of when the identity was resolved
 *
 * @param {string} agentName full ENS name (agent.agentcreditbureau.eth)
 * @param {string} resolverAddress the agent's own Permissioned Resolver
 * @param {string} signerKey private key of the controller (owns the resolver)
 * @param {object} status result of checkAgentBookStatus()
 * @param {object} [provider] ethers JsonRpcProvider override (default Sepolia)
 * @returns {Promise<{records: string[], txHashes: string[]}>}
 */
async function writeWorldIdentityRecords({ agentName, resolverAddress, signerKey, status, provider }) {
  const prov =
    provider || new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com");
  const wallet = new ethers.Wallet(signerKey, prov);
  const resolver = new ethers.Contract(resolverAddress, ["function setText(bytes name, string key, string value) external"], wallet);
  const dnsName = dnsEncode(agentName);
  const environment = status.environment || (status.mock ? "sandbox" : "production");
  const records = {
    [WORLD_IDENTITY_TEXT_KEYS.backed]: status.registered ? "true" : "false",
    [WORLD_IDENTITY_TEXT_KEYS.humanId]: status.humanId || "",
    [WORLD_IDENTITY_TEXT_KEYS.lookup]: status.registry ? `sandbox://${status.registry}` : AGENT_BOOK_ADDRESS,
    [WORLD_IDENTITY_TEXT_KEYS.timestamp]: new Date().toISOString(),
    [WORLD_IDENTITY_TEXT_KEYS.environment]: environment,
    [WORLD_IDENTITY_TEXT_KEYS.mock]: status.mock ? "true" : "false",
  };
  const txHashes = [];
  const written = [];
  for (const [key, value] of Object.entries(records)) {
    try {
      const tx = await resolver.setText(dnsName, key, value);
      const receipt = await tx.wait();
      txHashes.push(receipt.hash);
      written.push(`${key}=${value}`);
    } catch (error) {
      console.warn(`Could not write ENS record "${key}": ${error.message}`);
    }
  }
  return { records: written, txHashes };
}

module.exports = {
  AGENT_BOOK_ADDRESS,
  WORLD_IDENTITY_TEXT_KEYS,
  isAgentBookSandbox,
  dnsEncode,
  checkAgentBookStatus,
  worldAppVerifyUrl,
  registerInAgentBook,
  verifyAgentkitProof,
  writeWorldIdentityRecords,
};

if (require.main === module) {
  const [command, arg] = process.argv.slice(2);
  if (command === "status" && arg) {
    checkAgentBookStatus(arg)
      .then((status) => console.log(JSON.stringify(status, null, 2)))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  } else if (command === "verify-link" && arg) {
    console.log(worldAppVerifyUrl(arg));
  } else {
    console.error("Usage: node agent-provision.js <status|verify-link> <address>");
    process.exit(1);
  }
}