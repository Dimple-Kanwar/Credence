/**
 * verify-agent.js — World human-backing leg (World track).
 *
 * Proves a unique real human stands behind an agent using World AgentKit,
 * registers the agent in AgentBook (World Chain canonical contract), then
 * pushes that result on-chain via CreditBureau.setHumanBacking(...) so the
 * score bonus and Sybil-resistance premium apply.
 *
 * Unlike the old implementation (which grepped `agentkit-cli status` output),
 * this module checks the canonical AgentBook registry **on-chain** via
 * @worldcoin/agentkit's createAgentBookVerifier().lookupHuman() — the same
 * contract the World App proof flow writes to. Optional: pass a signed
 * `agentkit` header (from the agent's createAgentkitClient()) for full
 * SIWE-message credential verification before the on-chain flag is set.
 *
 * Docs: https://docs.world.org/agents/agent-kit/integrate
 *       https://docs.world.org/agents/agent-kit/sdk-reference
 */

const { ethers } = require("ethers");
require("dotenv").config();
const {
  checkAgentBookStatus,
  verifyAgentkitProof,
  registerInAgentBook,
  writeWorldIdentityRecords,
  worldAppVerifyUrl,
} = require("./agent-provision.js");

const CREDIT_BUREAU_ABI = [
  "function setHumanBacking(address controller, bool humanBacked) external",
  "function resolverOf(address controller) external view returns (address)",
];

/**
 * Verify (or provision) a real human behind an agent and push the flag
 * on-chain to CreditBureau.
 *
 * @param {string} controllerAddress the agent's controller wallet
 * @param {object} [options]
 * @param {string} [options.agentkitHeader] optional signed `agentkit` HTTP
 *   header for cryptographic credential verification ahead of the on-chain flag.
 * @param {string} [options.resourceUri] resource the header claims to access.
 * @param {boolean} [options.autoRegister] if the controller is not yet in
 *   AgentBook, run the interactive CLI registration (World App proof flow).
 * @param {boolean} [options.writeEnsIdentity] persist the resolved World
 *   identity into the agent's own ENS resolver text records (requires
 *   CONTROLLER_PRIVATE_KEY or a deployer==controller setup).
 * @returns {Promise<{registered: boolean, humanId: string|null, txHash?: string}>}
 */
async function verifyHumanBacking(controllerAddress, options = {}) {
  // --- resolve the human behind the wallet --------------------------------
  let status;
  if (options.agentkitHeader) {
    const proof = await verifyAgentkitProof({
      header: options.agentkitHeader,
      resourceUri: options.resourceUri || "https://credence.eth.limo/api/world/verify",
    });
    if (!proof.valid) throw new Error(`AgentKit proof rejected: ${proof.error}`);
    if (!proof.humanId) throw new Error(proof.error || "Agent is not registered in the AgentBook");
    status = { registered: true, humanId: proof.humanId, address: proof.address };
    console.log(`AgentKit proof verified — signer ${proof.address} is human ${proof.humanId}.`);
  } else {
    status = await checkAgentBookStatus(controllerAddress);
  }

  if (!status.registered) {
    if (options.autoRegister) {
      console.log(`Address not in AgentBook — running the World App proof flow for ${status.address}…`);
      const res = await registerInAgentBook(status.address);
      console.log(res.stdout);
      status = await checkAgentBookStatus(status.address);
    }
    if (!status.registered) {
      throw new Error(
        `No unique human verified for ${status.address}.`
      );
    }
  }

  // --- option 1: write the World identity into the ENS identity -----------
  if (options.writeEnsIdentity) {
    const key = process.env.CONTROLLER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    const provider = new ethers.JsonRpcProvider(
      process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com"
    );
    const bureau = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, provider);
    const resolverAddress = await bureau.resolverOf(status.address);
    const ensName = options.ensName;
    if (key && resolverAddress && resolverAddress !== ethers.ZeroAddress && ensName) {
      const res = await writeWorldIdentityRecords({
        agentName: ensName,
        resolverAddress,
        signerKey: key,
        status,
        provider,
      });
      console.log(`World identity written to ENS records of ${ensName}: ${res.records.join(", ")}`);
    } else {
      console.warn(
        "Skipped writing ENS identity records: need CONTROLLER_PRIVATE_KEY, the agent registered with the bureau (resolverOf), and an ensName."
      );
    }
  }

  // --- option 2: push on-chain flag to CreditBureau ------------------------
  const provider = new ethers.JsonRpcProvider(
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com"
  );
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const bureau = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, wallet);

  const tx = await bureau.setHumanBacking(status.address, true);
  const receipt = await tx.wait();
  console.log(`Human backing confirmed on-chain for ${status.address} (human ${status.humanId}). tx: ${receipt.hash}`);
  return { registered: true, humanId: status.humanId, txHash: receipt.hash };
}

// CLI:
//   node verify-agent.js <controllerAddress> [--auto-register] [--ens-name <name>] [--header <b64>] [--uri <url>]
//   node verify-agent.js --status <controllerAddress>   (credential check only, no tx)
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--status") {
    const [, address] = args;
    if (!address) {
      console.error("Usage: node verify-agent.js --status <controllerAddress>");
      process.exit(1);
    }
    checkAgentBookStatus(address)
      .then((status) => console.log(JSON.stringify(status, null, 2)))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
    return;
  }
  const [controllerAddress] = args;
  // Only read a flag's value when the flag was actually passed — indexOf
  // returns -1 for absent flags and would otherwise pick up the controller
  // address as the option value (e.g. --header missing -> args[0]).
  function flagValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  }
  const options = {
    autoRegister: args.includes("--auto-register"),
    writeEnsIdentity: args.includes("--ens-name"),
    ensName: flagValue("--ens-name"),
    agentkitHeader: flagValue("--header"),
    resourceUri: flagValue("--uri"),
  };
  if (!controllerAddress) {
    console.error(
      "Usage: node verify-agent.js <controllerAddress> [--auto-register] [--ens-name <fullName>] [--header <b64>] [--uri <resourceUri>]"
    );
    process.exit(1);
  }
  verifyHumanBacking(controllerAddress, options)
    .then((res) => console.log("Result:", res))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { verifyHumanBacking };