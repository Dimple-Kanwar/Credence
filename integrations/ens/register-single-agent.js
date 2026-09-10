/**
 * register-single-agent.js
 *
 * Run ONCE PER AGENT, after setup-agent-namespace.js has run once for the
 * whole project. Three steps:
 *
 *   1. Deploy a Permissioned Resolver proxy for the agent's controller
 *      address via the Verifiable Factory (each account gets its own
 *      resolver instance — docs.ens.domains/ensv2/permissioned-resolver).
 *   2. Call our AgentSubnameRegistrar.register() to mint the agent's name
 *      (e.g. "trader.agentcreditbureau.eth") pointed at that resolver.
 *   3. Use the resolver's grantSetterRoles() to grant the CreditBureau
 *      contract ROLE_SET_TEXT scoped to ONLY the "spend-limit-wei" key —
 *      this is the actual enforcement mechanism: CreditBureau can update
 *      this agent's spend-limit record, and nothing else, on this
 *      resolver. (docs.ens.domains/ensv2/permissioned-resolver#eac-integration)
 */

const { ethers } = require("ethers");
require("dotenv").config();

const VERIFIABLE_FACTORY_ADDRESS =
  process.env.ENS_VERIFIABLE_FACTORY || "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780";
const PERMISSIONED_RESOLVER_IMPL_ADDRESS =
  process.env.ENS_PERMISSIONED_RESOLVER_IMPL || "0xa9d3814ab151bf6e37a427432795371a8361614e";
const ENS_ROOT_NAME = process.env.ENS_ROOT_NAME || "agentcreditbureau.eth";

const SPEND_LIMIT_TEXT_KEY = "com.agentcreditbureau.spend-limit-wei";
const ROLE_SET_TEXT = 1n << 4n; // confirmed: docs.ens.domains/ensv2/permissioned-resolver

const VERIFIABLE_FACTORY_ABI = [
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address proxy)",
  "function verifyContract(address proxy) external view returns (address implementation)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
];

const RESOLVER_INIT_ABI = ["function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)"];

// Latest ENSv2 Permissioned Resolver ABI (docs at
// docs.ens.domains/ensv2/permissioned-resolver). Two breaking changes vs the
// namechain-127 ABI the older code used:
//
//   1. There is NO authorizeTextRoles(). Argument-scoped roles are granted
//      with grantSetterRoles(setter, account), where `setter` is ABI-encoded
//      calldata of the setter to authorize. Only the function selector and
//      the argument matter — the name and value parts are ignored — and the
//      resolver derives the matching role (ROLE_SET_TEXT for setText) itself.
//      The caller must hold the corresponding admin role
//      (ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128).
//
//   2. Setters are name-based: they take the DNS-encoded name as `bytes`,
//      not a bytes32 namehash (e.g. setText(bytes name, string key,
//      string value)). There are no standalone record getters; records are
//      read through resolve(name, profileCalldata).
const RESOLVER_ABI = [
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
  "function grantSetterRoles(bytes setter, address account) external",
  // Included only to ABI-encode setter calldata for grantSetterRoles().
  "function setText(bytes name, string key, string value) external",
];

const AGENT_SUBNAME_REGISTRAR_ABI = [
  "function register(string label, address controller, address resolver, bool humanBacked, uint64 duration) external returns (uint256 tokenId)",
  "function isAvailable(string label) public view returns (bool)"
];


const ALL_ROLES = BigInt("0x" + "1".repeat(64));

function getSigner() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  return new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
}

/**
 * The Permissioned Resolver's initialize() grants the grants array's
 * roleBitmaps on ROOT_RESOURCE exactly as passed — here ALL_ROLES to the
 * CONTROLLER. grantSetterRoles() therefore must be sent by the controller's
 * wallet (it holds ROLE_SET_TEXT_ADMIN), not the deployer's. If
 * CONTROLLER_PRIVATE_KEY is set we use it (the general case); otherwise we
 * fall back to the deployer key, which only works when the deployer IS the
 * controller.
 */
function getControllerSigner(controllerAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  if (process.env.CONTROLLER_PRIVATE_KEY) {
    return new ethers.Wallet(process.env.CONTROLLER_PRIVATE_KEY, provider);
  }
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  if (deployer.address.toLowerCase() !== controllerAddress.toLowerCase()) {
    console.warn(
      "WARNING: CONTROLLER_PRIVATE_KEY is not set and the deployer != controller. " +
        "grantSetterRoles() will be rejected by the real Permissioned Resolver " +
        "(the controller holds the roles + admin roles, not the deployer). Use " +
        "the frontend or set CONTROLLER_PRIVATE_KEY."
    );
  }
  return deployer;
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

/** Step 1 */
async function deployAgentResolver(controllerAddress) {
  const wallet = getSigner();
  const factory = new ethers.Contract(VERIFIABLE_FACTORY_ADDRESS, VERIFIABLE_FACTORY_ABI, wallet);

  const version = 0n;
  const salt = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "uint256"],
        [ethers.keccak256(ethers.toUtf8Bytes("OwnedResolver")), controllerAddress, version]
      )
    )
  );

  const initIface = new ethers.Interface(RESOLVER_INIT_ABI);
  const resolverInitData = initIface.encodeFunctionData("initialize", [[{ account: controllerAddress, roleBitmap: ALL_ROLES }], []]);

  console.log(`Deploying resolver proxy for ${controllerAddress}...`);
  const tx = await factory.deployProxy(PERMISSIONED_RESOLVER_IMPL_ADDRESS, salt, resolverInitData);
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

  const resolverAddress = deployedLog.args.proxyAddress;
  console.log("Agent resolver deployed at:", resolverAddress);
  return resolverAddress;
}

/** Step 2 */
async function registerAgent(registrarAddress, label, controllerAddress, resolverAddress, humanBacked, durationSeconds) {
  const wallet = getSigner();
  const registrar = new ethers.Contract(registrarAddress, AGENT_SUBNAME_REGISTRAR_ABI, wallet);
  const available = await registrar.isAvailable(label);
  if (!available) {
    throw new Error(`AgentSubnameRegistrar reports that ${label}.${ENS_ROOT_NAME} is not available.`);
  }
  console.log(`Registering ${label}.${ENS_ROOT_NAME} for ${controllerAddress}...`);
  const tx = await registrar.register(label, controllerAddress, resolverAddress, humanBacked, durationSeconds);
  const receipt = await tx.wait();
  console.log("Agent registered. tx:", receipt.hash);
  return receipt;
}

/** Step 3 — the actual enforcement wiring */
async function grantCreditBureauSpendLimitRole(resolverAddress, fullAgentName, creditBureauAddress, controllerAddress) {
  // grantSetterRoles must be called by an account holding the corresponding
  // admin role — ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128 — on this
  // resolver. The CONTROLLER received ALL_ROLES from initialize(), so this
  // must run as the controller wallet.
  const wallet = getControllerSigner(controllerAddress);
  const resolver = new ethers.Contract(resolverAddress, RESOLVER_ABI, wallet);
  const dnsName = dnsEncode(fullAgentName);

  console.log(`Granting CreditBureau ROLE_SET_TEXT scoped to "${SPEND_LIMIT_TEXT_KEY}" on ${fullAgentName}...`);
  // The latest ENSv2 resolver has no authorizeTextRoles(). Argument-scoped
  // roles are granted by passing ABI-encoded setter calldata to
  // grantSetterRoles(): only the function selector and the argument (here
  // the text key) are inspected — the name and value parts are ignored. We
  // still build the calldata with the agent's DNS-encoded name for clarity.
  const setterCalldata = resolver.interface.encodeFunctionData("setText", [
    dnsName,
    SPEND_LIMIT_TEXT_KEY,
    "",
  ]);
  const tx = await resolver.grantSetterRoles(setterCalldata, creditBureauAddress);
  const receipt = await tx.wait();
  console.log("Scoped role granted. tx:", receipt.hash);
  console.log(
    "CreditBureau can now update this agent's spend-limit text record, and ONLY that record — " +
      "it cannot touch avatar, other text keys, addr, contenthash, etc."
  );
  return receipt;
}

module.exports = {
  SPEND_LIMIT_TEXT_KEY,
  ROLE_SET_TEXT,
  dnsEncode,
  deployAgentResolver,
  registerAgent,
  grantCreditBureauSpendLimitRole,
};

// CLI usage:
//   node register-single-agent.js <label> <controllerAddress> [registrarAddress] [creditBureauAddress] [rootName]
// The registrar/bureau/root defaults fall back to your .env so the documented
// "Required configuration" keys are honored without always typing addresses.
if (require.main === module) {
  let [label, controllerAddress, registrarAddress, creditBureauAddress, rootName] = process.argv.slice(2);
  registrarAddress = registrarAddress || process.env.ENS_AGENT_REGISTRAR_ADDRESS;
  creditBureauAddress = creditBureauAddress || process.env.CREDIT_BUREAU_ADDRESS;
  rootName = rootName || ENS_ROOT_NAME;
  if (!label || !controllerAddress || !registrarAddress || !creditBureauAddress) {
    console.error(
      "Usage: node register-single-agent.js <label> <controllerAddress> <registrarAddress> <creditBureauAddress> <rootName>" +
        "\n  or set ENS_AGENT_REGISTRAR_ADDRESS and CREDIT_BUREAU_ADDRESS in .env and pass label + controllerAddress."
    );
    process.exit(1);
  }
  (async () => {
    const resolverAddress = await deployAgentResolver(controllerAddress);
    await registerAgent(registrarAddress, label, controllerAddress, resolverAddress, true, 365 * 24 * 60 * 60);
    await grantCreditBureauSpendLimitRole(resolverAddress, `${label}.${rootName}`, creditBureauAddress, controllerAddress);
    console.log("\nENS identity minted and EAC role scoped.");
    console.log("Next: have the CONTROLLER wallet call CreditBureau.registerAgent(" + `\"${label}.${rootName}\", true` + ") —");
    console.log("  the bureau verifies subname ownership on-chain (getOwner) and then writes the initial");
    console.log("  spend limit into the resolver via the scoped EAC text role. The frontend does this inline.");
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
