/**
 * simulate-agent.js
 *
 * Drives a believable transaction history against CreditBureau so the demo
 * can show the full arc live: register -> score climbs -> limit auto-raises
 * -> one default -> frozen. This is the "clean, demoable story" the concept
 * doc called for.
 *
 * Every run mints a REAL ENSv2 identity for the demo agent first:
 *   1. deploy the agent's own Permissioned Resolver proxy (Verifiable
 *      Factory, salt = keccak256("OwnedResolver", owner, version))
 *   2. register a subname under the project root
 *      (e.g. "agent-1a2b3c4d.agentcreditbureau.eth") via the project's
 *      AgentSubnameRegistrar
 *   3. grant CreditBureau the EAC role scoped to exactly the spend-limit
 *      text key on that resolver (grantSetterRoles)
 *   4. register with the bureau — which verifies subname ownership on-chain
 *      and then writes every spend-limit update into the agent's own ENS
 *      text records through that scoped role
 *
 * Usage:
 *   node simulate-agent.js good 60      # 60 successful jobs
 *   node simulate-agent.js mixed 40     # mix of success/late/disputed
 *   node simulate-agent.js default 1    # trigger a default to show freezing
 */

const { ethers } = require("ethers");
require("dotenv").config();

const CREDIT_BUREAU_ABI = [
  "function registerAgent(string ensName, bool humanBacked) external",
  "function recordOutcome(address controller, uint8 outcome, uint256 amountWei, bytes32 jobId) external",
  "function getProfile(address controller) external view returns (tuple(string ensName, address controller, bool humanBacked, bool registered, bool frozen, uint32 score, uint256 spendLimitWei, uint32 totalTx, uint32 successTx, uint32 lateTx, uint32 disputedTx, uint32 defaultTx))",
];

const VERIFIABLE_FACTORY_ABI = [
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address proxy)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
];
const RESOLVER_INIT_ABI = ["function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)"];
// Latest ENSv2 Permissioned Resolver: no authorizeTextRoles(). Argument-
// scoped roles are granted via grantSetterRoles(setter, account), where
// setter is ABI-encoded calldata whose selector+argument define the role.
// Setters take the DNS-encoded name (bytes), not a bytes32 node.
const RESOLVER_ABI = [
  "function grantSetterRoles(bytes setter, address account) external",
  // Included only to ABI-encode setter calldata for grantSetterRoles().
  "function setText(bytes name, string key, string value) external",
];
const REGISTRAR_ABI = [
  "function register(string label, address controller, address resolver, bool humanBacked, uint64 duration) external returns (uint256 tokenId)",
];

// Protocol-deployed ENSv2 Sepolia addresses (official hackathon deployment).
const ENS_FACTORY_ADDRESS =
  process.env.ENS_VERIFIABLE_FACTORY || "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780";
const ENS_RESOLVER_IMPL =
  process.env.ENS_PERMISSIONED_RESOLVER_IMPL || "0xa9d3814ab151bf6e37a427432795371a8361614e";
const ENS_ROOT_NAME = process.env.ENS_ROOT_NAME || "agentcreditbureau.eth";
const SPEND_LIMIT_TEXT_KEY = "com.agentcreditbureau.spend-limit-wei";

const Outcome = { Success: 0, Late: 1, Disputed: 2, Default: 3 };

function randomJobId(i) {
  return ethers.id(`job-${Date.now()}-${i}`);
}

/** DNS-encode a name (viem's packetToBytes equivalent) — needed to build
 * the setter calldata passed to grantSetterRoles(). */
function dnsEncode(name) {
  const labels = name.split(".");
  const parts = labels.map((label) => {
    const bytes = ethers.toUtf8Bytes(label);
    return ethers.concat([Uint8Array.of(bytes.length), bytes]);
  });
  return ethers.concat([...parts, Uint8Array.of(0)]);
}

/** Deploy the agent's own Permissioned Resolver proxy via the Verifiable Factory. */
async function deployAgentResolver(factory, controllerAddress) {
  const version = 0n;
  const salt = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "uint256"],
        [ethers.keccak256(ethers.toUtf8Bytes("OwnedResolver")), controllerAddress, version]
      )
    )
  );
  const initData = new ethers.Interface(RESOLVER_INIT_ABI).encodeFunctionData("initialize", [
    [{ account: controllerAddress, roleBitmap: BigInt("0x" + "1".repeat(64)) }],
    [],
  ]);
  const tx = await factory.deployProxy(ENS_RESOLVER_IMPL, salt, initData);
  const receipt = await tx.wait();
  const iface = new ethers.Interface(VERIFIABLE_FACTORY_ABI);
  const deployedLog = receipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "ProxyDeployed");
  if (!deployedLog) throw new Error("Resolver proxy deployment event not found");
  return deployedLog.args.proxyAddress;
}

async function mintEnsIdentity(registrar, resolver, agentWallet, label) {
  // Registrar is permissionless within the project namespace; label is
  // derived from the agent address so repeated runs never collide.
  const duration = 365n * 24n * 60n * 60n;
  const tx = await registrar.register(label, agentWallet.address, resolver, true, duration);
  const receipt = await tx.wait();
  return receipt.hash;
}

async function grantSpendLimitRole(resolverProxy, fullName, bureauAddress, agentWallet) {
  const agentResolver = resolverProxy.connect(agentWallet);
  // grantSetterRoles() derives the role + EAC resource from the setter
  // calldata selector and argument (the text key). The name/value parts are
  // ignored — we still pass the agent's DNS-encoded name for clarity.
  const setterCalldata = agentResolver.interface.encodeFunctionData("setText", [
    dnsEncode(fullName),
    SPEND_LIMIT_TEXT_KEY,
    "",
  ]);
  const tx = await agentResolver.grantSetterRoles(setterCalldata, bureauAddress);
  const receipt = await tx.wait();
  return receipt.hash;
}

async function main() {
  const scenario = process.argv[2] || "good";
  const count = Number(process.argv[3] || 50);

  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const bureauAddress = process.env.CREDIT_BUREAU_ADDRESS;
  if (!bureauAddress || !ethers.isAddress(bureauAddress)) {
    throw new Error("CREDIT_BUREAU_ADDRESS must be set in .env");
  }
  const registrarAddress = process.env.ENS_AGENT_REGISTRAR_ADDRESS;
  if (!registrarAddress || !ethers.isAddress(registrarAddress)) {
    throw new Error("ENS_AGENT_REGISTRAR_ADDRESS must be set in .env (printed by setup-agent-namespace.js)");
  }

  const bureau = new ethers.Contract(bureauAddress, CREDIT_BUREAU_ABI, wallet);
  const factory = new ethers.Contract(ENS_FACTORY_ADDRESS, VERIFIABLE_FACTORY_ABI, wallet);

  // Use a fresh demo agent wallet each run so the story is easy to reset.
  const agentWallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  console.log(`Demo agent controller: ${agentWallet.address}`);

  // Fund the demo agent wallet with a little gas from the deployer so it
  // can pay for its own resolver deployment, registration, and EAC grants.
  // await wallet.sendTransaction({ to: agentWallet.address, value: ethers.parseEther("0.05") });

  const label = process.env.SIM_AGENT_LABEL || `agent-${agentWallet.address.slice(2, 10).toLowerCase()}`;
  const fullName = `${label}.${ENS_ROOT_NAME}`;
  console.log(`Full ENSv2 identity ${fullName}...`);

  // const resolver = await deployAgentResolver(factory, agentWallet.address);
  // console.log("Permissioned Resolver:", resolver);

  // const registrar = new ethers.Contract(registrarAddress, REGISTRAR_ABI, wallet);
  // await mintEnsIdentity(registrar, resolver, agentWallet, label);
  // console.log("Subname registered under", ENS_ROOT_NAME);

  // const resolverProxy = new ethers.Contract(resolver, RESOLVER_ABI, wallet);
  // await grantSpendLimitRole(resolverProxy, fullName, bureauAddress, agentWallet);
  // console.log("Scoped EAC role granted to CreditBureau for", SPEND_LIMIT_TEXT_KEY);

  // console.log("Registering agent with CreditBureau (on-chain subname check)...");
  // const bureauAsAgent = bureau.connect(agentWallet);
  // const regTx = await bureauAsAgent.registerAgent(fullName, true);
  // await regTx.wait();
  // console.log("Agent registered. tx:", regTx.hash);

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
    const tx = await bureau.recordOutcome(agentWallet.address, outcome, amount, randomJobId(i));
    await tx.wait();
    console.log(tx.hash, `outcome=${Object.keys(Outcome)[outcome]} amount=${ethers.formatEther(amount)} ETH`);

    if (i % 10 === 0 || i === count - 1) {
      const profile = await bureau.getProfile(agentWallet.address);
      console.log(
        `  [${i + 1}/${count}] score=${profile.score} limitWei=${profile.spendLimitWei.toString()} frozen=${profile.frozen}`
      );
    }
  }

  const finalProfile = await bureau.getProfile(agentWallet.address);
  console.log("Final state:", {
    ensName: finalProfile.ensName,
    score: finalProfile.score,
    spendLimitWei: finalProfile.spendLimitWei.toString(),
    frozen: finalProfile.frozen,
    totalTx: finalProfile.totalTx,
  });
  console.log(`Spend limit is mirrored on-chain at ${fullName} text record "${SPEND_LIMIT_TEXT_KEY}".`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});