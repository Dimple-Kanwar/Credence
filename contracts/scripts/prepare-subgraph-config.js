const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  console.error(message);
  process.exit(1);
}

const artifactPath = path.resolve(__dirname, "../deployments/sepolia.json");
const yamlPath = path.resolve(__dirname, "../../subgraph/subgraph.yaml");

if (!fs.existsSync(artifactPath)) {
  fail(
    "Missing deployment artifact: contracts/deployments/sepolia.json. Run `cd contracts && npm run deploy:sepolia` first."
  );
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const bureauAddress = artifact.bureau || process.env.CREDIT_BUREAU_ADDRESS;
if (!bureauAddress) {
  fail("No bureau address found in deployment artifact or CREDIT_BUREAU_ADDRESS.");
}

const startBlock = process.env.GRAPH_START_BLOCK || artifact.startBlock || 0;
const yamlText = fs.readFileSync(yamlPath, "utf8");
const updated = yamlText
  .replace(/address: ".*"/, `address: "${bureauAddress}"`)
  .replace(/startBlock: \d+/, `startBlock: ${startBlock}`);

fs.writeFileSync(yamlPath, updated);
console.log(`Updated subgraph address to ${bureauAddress} and startBlock to ${startBlock}.`);
console.log(`Config written to ${yamlPath}`);
