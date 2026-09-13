/**
 * simulate-agent.js
 *
 * Prepares a believable transaction history against CreditBureau for an agent
 * that is ALREADY registered. Registration (ENSv2 subname + Permissioned
 * Resolver + EAC role scope + CreditBureau.registerAgent()) happens in the
 * frontend's "Register identity" flow — this script no longer mints anything.
 *
 * It only drives outcomes via CreditBureau.recordOutcome() on top of that
 * identity, so the demo can show the full arc live: score climbs -> limit
 * auto-raises -> freeze on default. Re-running simply appends more history
 * (every tx uses a fresh keccak jobId, so nothing collides).
 *
 * Pre-flight:
 *   1. reads CreditBureau.getProfile(controller)
 *   2. fails fast — with a pointer to the frontend register flow — if the
 *      agent is not registered yet
 *   3. warns if the agent is already frozen and the scenario isn't "default":
 *      a frozen agent only accepts Default outcomes on-chain, so the scenario
 *      is forced to "default" instead of reverting mid-loop
 *
 * The controller whose history is populated comes from SIM_AGENT_CONTROLLER
 * (address — e.g. the browser wallet that registered the agent in the
 * frontend) or, for backwards compat, from AGENT_PRIVATE_KEY.
 *
 * Usage:
 *   node simulate-agent.js good 60      # 60 successful jobs
 *   node simulate-agent.js mixed 40     # mix of success/late/disputed
 *   node simulate-agent.js default 1    # trigger a default to show freezing
 */

const { ethers } = require("ethers");
require("dotenv").config();

const CREDIT_BUREAU_ABI = [
  "function recordOutcome(address controller, uint8 outcome, uint256 amountWei, bytes32 jobId) external",
  "function getProfile(address controller) external view returns (tuple(string ensName, address controller, bool humanBacked, bool registered, bool frozen, uint32 score, uint256 spendLimitWei, uint32 totalTx, uint32 successTx, uint32 lateTx, uint32 disputedTx, uint32 defaultTx))",
];

const SPEND_LIMIT_TEXT_KEY = "com.agentcreditbureau.spend-limit-wei";

const Outcome = { Success: 0, Late: 1, Disputed: 2, Default: 3 };

function randomJobId(i) {
  return ethers.id(`job-${Date.now()}-${i}`);
}

function shortTx(hash) {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

async function main() {
  let scenario = process.argv[2] || "good";
  const count = Number(process.argv[3] || 50);

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const bureauAddress = process.env.CREDIT_BUREAU_ADDRESS;
  if (!bureauAddress || !ethers.isAddress(bureauAddress)) {
    throw new Error("CREDIT_BUREAU_ADDRESS must be set in .env");
  }

  // The agent's controller. If the frontend registered with a browser wallet
  // whose key isn't available here, point SIM_AGENT_CONTROLLER at that
  // address — the script never signs as the agent, so the private key is not
  // required anymore (only kept as a fallback for old workflows).
  let controller;
  const simController = process.env.SIM_AGENT_CONTROLLER;
  if (simController) {
    if (!ethers.isAddress(simController)) {
      throw new Error(`SIM_AGENT_CONTROLLER is not a valid address: ${simController}`);
    }
    controller = ethers.getAddress(simController);
  } else {
    controller = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider).address;
  }

  console.log("Demo agent controller:", controller);

  const bureau = new ethers.Contract(bureauAddress, CREDIT_BUREAU_ABI, wallet);

  // ---------------------------------------------------------------------
  // Pre-flight: the agent must already be registered (frontend did it).
  // ---------------------------------------------------------------------
  let profile;
  try {
    profile = await bureau.getProfile(controller);
  } catch (readErr) {
    throw new Error(`Could not read CreditBureau profile for ${controller} (${readErr.message}). ` +
      `Is CREDIT_BUREAU_ADDRESS=${bureauAddress} correct?`);
  }

  if (!profile.registered) {
    throw new Error(
      `Agent ${controller} is NOT registered with CreditBureau.\n` +
        `Register it first via the frontend ("Register identity" flow), which mints the ENSv2 ` +
        `subname + Permissioned Resolver and calls CreditBureau.registerAgent(). Then re-run this script.`
    );
  }

  console.log(`Already-registered agent "${profile.ensName}" — prepending history only.`);
  console.log(
    `  Starting profile: score=${profile.score} limitWei=${profile.spendLimitWei.toString()} ` +
      `frozen=${profile.frozen} tx=${profile.totalTx} ` +
      `(success=${profile.successTx} late=${profile.lateTx} disputed=${profile.disputedTx} default=${profile.defaultTx})`
  );

  if (profile.frozen && scenario !== "default") {
    console.warn(
      `  Agent is frozen — recordOutcome() only accepts Default outcomes while frozen. ` +
        `Forcing scenario "default".`
    );
    scenario = "default";
  }

  console.log(`Running scenario "${scenario}" for ${count} transactions...`);
  for (let i = 0; i < count; i++) {
    let outcome = Outcome.Success;
    if (scenario === "mixed") {
      const roll = Math.random();
      if (roll < 0.7) outcome = Outcome.Success;
      else if (roll < 0.85) outcome = Outcome.Late;
      else outcome = Outcome.Disputed;
    } else if (scenario === "default") {
      outcome = Outcome.Default;
    }

    const amount = ethers.parseEther((0.001 + Math.random() * 0.004).toFixed(6));
    const tx = await bureau.recordOutcome(controller, outcome, amount, randomJobId(i));
    await tx.wait();
    console.log(`${shortTx(tx.hash)} outcome=${Object.keys(Outcome)[outcome]} amount=${ethers.formatEther(amount)} ETH`);

    if (i % 10 === 0 || i === count - 1) {
      profile = await bureau.getProfile(controller);
      console.log(
        `  [${i + 1}/${count}] score=${profile.score} limitWei=${profile.spendLimitWei.toString()} frozen=${profile.frozen}`
      );
    }
  }

  const finalProfile = await bureau.getProfile(controller);
  console.log("Final state:", {
    ensName: finalProfile.ensName,
    score: finalProfile.score,
    spendLimitWei: finalProfile.spendLimitWei.toString(),
    frozen: finalProfile.frozen,
    totalTx: finalProfile.totalTx,
  });
  console.log(`Spend limit is mirrored on-chain at ${finalProfile.ensName} text record "${SPEND_LIMIT_TEXT_KEY}".`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});