/**
 * setup-agent-namespace.js
 *
 * ONE-TIME project setup (run once, not per-agent) — and run it BEFORE
 * deploying CreditBureau: the bureau's constructor pins the UserRegistry
 * proxy deployed here, and every agent registration is verified on-chain
 * against it.
 *   Requires: SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY and ENSV2_PAYMENT_TOKEN
 *             (an ERC20 the hackathon ETHRegistrar accepts) in ../.env.
 *
 *   1. Register the project's root name (e.g. "agentcreditbureau.eth")
 *      via the hackathon ETHRegistrar (commit -> wait MIN_COMMITMENT_AGE
 *      -> reveal — the standard commit-reveal flow).
 *   2. Deploy our own UserRegistry (a per-name subregistry) via the
 *      hackathon VerifiableFactory — exact salt scheme (keccak256 of
 *      "UserRegistry", root namehash, version) + initialize() ABI confirmed
 *      against https://docs.ens.domains/ensv2/verifiable-factory
 *   3. Attach it to the root name via ETHRegistry.setSubregistry(), so
 *      "*.agentcreditbureau.eth" resolves into our registry.
 *   4. Deploy our custom AgentSubnameRegistrar.sol (contracts-ens/) pointed
 *      at that registry.
 *   5. Grant the registrar ROLE_REGISTRAR + ROLE_RENEW on our registry's
 *      ROOT_RESOURCE, per docs.ens.domains/ensv2/tutorial-contract-developers.
 *
 * Per-agent registration (deploy a resolver, call the registrar, scope the
 * CreditBureau role, then CreditBureau.registerAgent() verifies ownership)
 * lives in register-single-agent.js — run that once per agent after this
 * setup completes.
 */

const { ethers, ensNormalize, namehash,  } = require("ethers");
require("dotenv").config();

// --- Real ETHOnline 2026 hackathon ENSv2 deployment addresses (Sepolia) ---
const ETH_REGISTRAR_ADDRESS = "0x7d1b7f586a62ac3f54b9a396849757814283270b";
const ETH_REGISTRY_ADDRESS = "0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e";
const VERIFIABLE_FACTORY_ADDRESS = "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780";
const USER_REGISTRY_IMPL_ADDRESS = "0x47b442d0cf617c41cabaff5f02f44dd1e5f72546";

// --- EAC role constants (confirmed: docs.ens.domains/ensv2/tutorial-contract-developers) ---
const ROLE_REGISTRAR = 1n << 0n;
const ROLE_RENEW = 1n << 16n;
// Grants every role + every admin role on the registry to the deployer —
// exact literal from the Verifiable Factory docs code example.
const ALL_ROLES = BigInt("0x" + "1".repeat(64));

const ETH_REGISTRAR_ABI = [
  "function commit(bytes32 commitment) external",
  "function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer) external returns (uint256)",
  "function makeCommitment(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,bytes32 referrer) external pure returns (bytes32)",
  "function getRegisterPrice(string label,uint64 duration,address paymentToken) external view returns (uint256 base,uint256 premium)",
  "function MIN_COMMITMENT_AGE() external view returns (uint64)",
  "function isAvailable(string label) external view returns (bool)",
];

const PERMISSIONED_REGISTRY_ABI = [
  "function setSubregistry(uint256 anyId, address registry) external",
  "function grantRootRoles(uint256 roleBitmap, address account) external returns (bool)",
];

const VERIFIABLE_FACTORY_ABI = [
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address proxy)",
  "function verifyContract(address proxy) external view returns (address implementation)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
];

const PAYMENT_TOKEN_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

const USER_REGISTRY_INIT_ABI = ["function initialize((address account, uint256 roleBitmap)[] grants)"];

function getSigner() {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  return new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
}

/** Step 1 */
async function registerRootName(label, ownerAddress) {
  const wallet = getSigner();
  const registrar = new ethers.Contract(ETH_REGISTRAR_ADDRESS, ETH_REGISTRAR_ABI, wallet);
  const oneYear = 365n * 24n * 60n * 60n;

  const isAvailable = await registrar.isAvailable(label);
  if (!isAvailable) {
    throw new Error(`Root name ${label}.eth is not available for registration.`);
  } else {
    console.log(`Root name ${label}.eth is available for registration.`);

    console.log(`Registering root name ${label}.eth for ${ownerAddress}...`);
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const subregistry = ethers.ZeroAddress;
    const resolver = ethers.ZeroAddress;
    const referrer = ethers.ZeroHash;
    const paymentToken = process.env.ENSV2_PAYMENT_TOKEN;
    if (!paymentToken || !ethers.isAddress(paymentToken)) {
      throw new Error("ENSV2_PAYMENT_TOKEN must be set to the supported ERC20 payment token address.");
    }

    // Get the registration price (base + premium) for the label, so we can approve the payment token.
    const [base, premium] = await registrar.getRegisterPrice(label, oneYear, paymentToken);
    console.log(`Registration price for ${label}.eth: base=${base}, premium=${premium}`);

    // 3. Approve the registrar to spend the payment token
    const totalCost = base + premium;
    console.log(`Approving ${totalCost} of payment token ${paymentToken} for registrar...`);
    const paymentTokenContract = new ethers.Contract(paymentToken, PAYMENT_TOKEN_ABI, wallet);
    // const approveTx = await paymentTokenContract.approve(ETH_REGISTRAR_ADDRESS, totalCost);
    // console.log(`Approval transaction sent. tx: ${approveTx.hash}`);
    // await approveTx.wait();
    // console.log(`Approved ${totalCost} of payment token ${paymentToken} for registrar. tx: ${approveTx.hash}`);

    // Check allowance to ensure approval succeeded
    console.log("Checking allowance for registrar...");
    const allowance = await paymentTokenContract.allowance(wallet.address, ETH_REGISTRAR_ADDRESS);
    if (allowance < totalCost) {
      throw new Error(
        `Approval failed: allowance ${allowance} is less than required ${totalCost}. Check your payment token balance and approval.`
      );
    }
    console.log(`Approval successful: allowance is ${allowance}. Proceeding with registration.`);

    // Commit to the registration
    console.log("Making commitment...");

    const commitment = await registrar.makeCommitment(
      label,
      ownerAddress,
      secret,
      subregistry,
      resolver,
      oneYear,
      referrer
    );
    await (await registrar.commit(commitment)).wait();
    const minimumAge = Number(await registrar.MIN_COMMITMENT_AGE());
    console.log(`Commitment recorded. Wait at least ${minimumAge}s before revealing registration.`);
    await new Promise((resolve) => setTimeout(resolve, (minimumAge + 1) * 1000));

    console.log("Revealing registration...");
    console.log({ label, ownerAddress, secret, subregistry, resolver, oneYear, referrer });
    const tx = await registrar.register(
      label,
      ownerAddress,
      secret,
      subregistry,
      resolver,
      oneYear,
      paymentToken,
      referrer
    );
    const receipt = await tx.wait();
    console.log("Root name registered. tx:", receipt.hash);
    return receipt;
  }
}

/** Step 2: deploy our own UserRegistry via the Verifiable Factory */
async function deployAgentRegistry(rootLabel, ownerAddress) {
  const wallet = getSigner();
  const factory = new ethers.Contract(VERIFIABLE_FACTORY_ADDRESS, VERIFIABLE_FACTORY_ABI, wallet);

  // namehash("<rootLabel>.eth") — computed manually since we don't have a
  // full ENS namehash util wired in; for a single-label .eth name this is:
  //   namehash = keccak256(keccak256(0x00...00, keccak256("eth")), keccak256(rootLabel))
  const normalizedRootLabel = ensNormalize(rootLabel);
  console.log(`Normalized root label: ${normalizedRootLabel}`);
  const rootNamehash = namehash(normalizedRootLabel + ".eth");
  console.log(`Root namehash: ${rootNamehash}`);

  const version = 0n;
  const salt = BigInt(
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "uint256"],
        [ethers.keccak256(ethers.toUtf8Bytes("UserRegistry")), rootNamehash, version]
      )
    )
  );
  console.log(`Salt for UserRegistry deployment: ${salt}`);

  const registryInitData = new ethers.Interface(USER_REGISTRY_INIT_ABI).encodeFunctionData('initialize', [[{ account: ownerAddress, roleBitmap: ALL_ROLES }]]);
  console.log("Deploying agent subregistry via VerifiableFactory...");
  console.log(`Implementation: ${USER_REGISTRY_IMPL_ADDRESS}, Salt: ${salt}, registryInitData: ${registryInitData}`);

  const tx = await factory.deployProxy(USER_REGISTRY_IMPL_ADDRESS, salt, registryInitData);
  console.log("Deployment transaction sent. Waiting for confirmation...");
  const registryReceipt = await tx.wait();

  const iface = new ethers.Interface(VERIFIABLE_FACTORY_ABI);
  const deployedLog = registryReceipt.logs
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "ProxyDeployed");

  const registryAddress = deployedLog.args.proxyAddress;
  console.log("Agent subregistry deployed at:", registryAddress);
  return registryAddress;
}

/** Step 3 */
async function attachSubregistry(rootTokenId, subregistryAddress) {
  const wallet = getSigner();
  const ethRegistry = new ethers.Contract(ETH_REGISTRY_ADDRESS, PERMISSIONED_REGISTRY_ABI, wallet);
  const tx = await ethRegistry.setSubregistry(rootTokenId, subregistryAddress);
  const receipt = await tx.wait();
  console.log("Subregistry attached to root name. tx:", receipt.hash);
  return receipt;
}

/** Step 4: deploy our custom AgentSubnameRegistrar (contracts-ens/) */
async function deployAgentSubnameRegistrar(registryAddress, minDurationSeconds) {
  const wallet = getSigner();
  console.log(`Deploying AgentSubnameRegistrar for registry ${registryAddress} with minDurationSeconds=${minDurationSeconds}...`);
  // Compiled via `forge build` in contracts-ens/ — path assumes Foundry's
  // default `out/` layout.
  const artifact = require("../../contracts-ens/out/AgentSubnameRegistrar.sol/AgentSubnameRegistrar.json");
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
  const registrar = await factory.deploy(registryAddress, minDurationSeconds);
  await registrar.waitForDeployment();
  const address = await registrar.getAddress();
  console.log("AgentSubnameRegistrar deployed at:", address);
  return address;
}

/** Step 5 */
async function grantRegistrarRoles(registryAddress, registrarAddress) {
  const wallet = getSigner();
  console.log(`Granting ROLE_REGISTRAR + ROLE_RENEW to registrar ${registrarAddress} on registry ${registryAddress}...`);
  const registry = new ethers.Contract(registryAddress, PERMISSIONED_REGISTRY_ABI, wallet);
  const tx = await registry.grantRootRoles(ROLE_REGISTRAR | ROLE_RENEW, registrarAddress);
  const receipt = await tx.wait();
  console.log("Granted ROLE_REGISTRAR + ROLE_RENEW to registrar. tx:", receipt.hash);
  return receipt;
}

module.exports = {
  ETH_REGISTRAR_ADDRESS,
  ETH_REGISTRY_ADDRESS,
  VERIFIABLE_FACTORY_ADDRESS,
  USER_REGISTRY_IMPL_ADDRESS,
  ROLE_REGISTRAR,
  ROLE_RENEW,
  ALL_ROLES,
  registerRootName,
  deployAgentRegistry,
  attachSubregistry,
  deployAgentSubnameRegistrar,
  grantRegistrarRoles,
};

if (require.main === module) {
  const [rootLabel] = process.argv.slice(2);
  if (!rootLabel) {
    console.error("Usage: node setup-agent-namespace.js <rootLabel>   (e.g. agentcreditbureau)");
    process.exit(1);
  }
  (async () => {
    const wallet = getSigner();
    console.log(`Registering root name ${rootLabel}...`);
    await registerRootName(rootLabel, wallet.address);
    const registryAddress = await deployAgentRegistry(rootLabel, wallet.address);
    console.log(`Deployed AgentRegistry at: ${registryAddress}`);
    const rootLabelId = ethers.keccak256(ethers.toUtf8Bytes(rootLabel));
    console.log(`Root label ID (keccak256 of "${rootLabel}"): ${rootLabelId}`);
    await attachSubregistry(rootLabelId, registryAddress);
    const registrarAddress = await deployAgentSubnameRegistrar(registryAddress, 30 * 24 * 60 * 60);
    await grantRegistrarRoles(registryAddress, registrarAddress);
    console.log("\nSetup complete. Save these to your .env (and to frontend/.env for VITE_*):");
    console.log(`ENS_AGENT_REGISTRY_ADDRESS=${registryAddress}`);
    console.log(`ENS_AGENT_REGISTRAR_ADDRESS=${registrarAddress}`);
    console.log("Then deploy CreditBureau with `cd contracts && npm run deploy:sepolia` — its");
    console.log(`constructor pins ENS_AGENT_REGISTRY_ADDRESS=${registryAddress} for on-chain subname checks.`);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
