const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

function writeDeploymentArtifact(bureauAddress, escrowAddress, deployerAddress, networkName, startBlock) {
  const outputDir = path.join(__dirname, "../deployments");
  fs.mkdirSync(outputDir, { recursive: true });

  const artifact = {
    network: networkName,
    deployer: deployerAddress,
    bureau: bureauAddress,
    escrow: escrowAddress,
    // The block CreditBureau was deployed at — the subgraph config script
    // reads this back so indexing starts at the right block instead of 0.
    startBlock,
    deployedAt: new Date().toISOString(),
    notes: [
      "CreditBureau deployed on Sepolia for the ENSv2/World/Graph/Hedera demo flow.",
      "Escrow is authorized as a reporter so settlement enforcement happens on-chain.",
    ],
  };

  const outputFile = path.join(outputDir, `${networkName}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(artifact, null, 2) + "\n");
  console.log("Deployment artifact written to:", outputFile);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const networkName = hre.network.name || "localhost";

  // CreditBureau verifies each agent's ENSv2 subname ownership against the
  // project's UserRegistry, so the registry must exist (and be wired to the
  // project root name) BEFORE the bureau is deployed. Run
  //   node integrations/ens/setup-agent-namespace.js <rootLabel>
  // first and put the printed ENS_AGENT_REGISTRY_ADDRESS in your .env.
  const ensRegistryAddress = process.env.ENS_AGENT_REGISTRY_ADDRESS;
  if (!ensRegistryAddress || !hre.ethers.isAddress(ensRegistryAddress)) {
    throw new Error(
      "ENS_AGENT_REGISTRY_ADDRESS must be set to the project's ENSv2 UserRegistry proxy. " +
        "Run `node integrations/ens/setup-agent-namespace.js <rootLabel>` first, then copy the " +
        "printed ENS_AGENT_REGISTRY_ADDRESS into .env."
    );
  }

  console.log("Deploying CreditBureau with account:", deployer.address);
  console.log("ENSv2 project registry (ownership + resolver source):", ensRegistryAddress);

  const CreditBureau = await hre.ethers.getContractFactory("CreditBureau");
  const bureau = await CreditBureau.deploy(ensRegistryAddress);
  await bureau.waitForDeployment();

  const bureauAddress = await bureau.getAddress();
  const bureauReceipt = await bureau.deploymentTransaction().wait();
  const startBlock = bureauReceipt.blockNumber;
  console.log("CreditBureau deployed to:", bureauAddress, "at block", startBlock);

  const CreditEscrow = await hre.ethers.getContractFactory("CreditEscrow");
  const escrow = await CreditEscrow.deploy(bureauAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  await (await bureau.setReporter(escrowAddress, true)).wait();
  console.log("CreditEscrow deployed to:", escrowAddress);
  console.log("CreditEscrow authorized as a CreditBureau reporter");

  writeDeploymentArtifact(bureauAddress, escrowAddress, deployer.address, networkName, startBlock);

  console.log("Next steps:");
  console.log("  1. Update subgraph/subgraph.yaml with the deployed bureau address and start block.");
  console.log("  2. Save the same address in your .env as CREDIT_BUREAU_ADDRESS or VITE_CREDIT_BUREAU_ADDRESS.");
  console.log("  3. Use", escrowAddress, "for credit-limited job settlement and live demo evidence.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
