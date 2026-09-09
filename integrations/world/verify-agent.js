/**
 * verify-agent.js
 *
 * Human-backing leg (World track): proves a unique real human stands behind
 * an agent using World AgentKit, registers the agent in AgentBook, and then
 * pushes that result on-chain via CreditBureau.setHumanBacking(...) so the
 * score bonus and Sybil-resistance premium apply.
 *
 * Docs: https://docs.world.org/agents/agent-kit/integrate
 * Repo: https://github.com/worldcoin/agentkit
 *
 * Flow:
 *   1. Human completes a World ID proof (via the World App / IDKit) tying
 *      their unique-human credential to the agent's controller address.
 *   2. AgentKit verifies the proof and registers the agent in AgentBook.
 *   3. This script reads that verification result and calls
 *      CreditBureau.setHumanBacking(controller, true) on-chain.
 */

const { ethers } = require("ethers");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
require("dotenv").config();

const execFileAsync = promisify(execFile);

const CREDIT_BUREAU_ABI = [
  "function setHumanBacking(address controller, bool humanBacked) external",
];

async function verifyHumanBacking(agentControllerAddress) {
  // AgentKit registration is performed through the maintained CLI, which
  // invokes the World App proof flow and AgentBook relay.
  const { stdout } = await execFileAsync(
    process.env.AGENTKIT_CLI || "npx",
    ["--yes", "@worldcoin/agentkit-cli", "status", agentControllerAddress],
    { env: process.env }
  );
  if (/not registered|unregistered|not found|inactive/i.test(stdout) || !/registered|verified|active/i.test(stdout)) {
    throw new Error(`AgentKit did not confirm a registered human-backed agent: ${stdout.trim()}`);
  }

  // --- Step 3: push result on-chain to CreditBureau -----------------------
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const bureau = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, wallet);

  const tx = await bureau.setHumanBacking(agentControllerAddress, true);
  await tx.wait();
  console.log(`Human backing confirmed on-chain for ${agentControllerAddress}. tx: ${tx.hash}`);
  return true;
}

// CLI usage: node verify-agent.js 0xAgentControllerAddress
if (require.main === module) {
  const [agentControllerAddress] = process.argv.slice(2);
  if (!agentControllerAddress) {
    console.error("Usage: node verify-agent.js <agentControllerAddress>");
    process.exit(1);
  }
  verifyHumanBacking(agentControllerAddress)
    .then((ok) => console.log("Result:", ok))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { verifyHumanBacking };
