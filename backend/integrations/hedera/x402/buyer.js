/**
 * buyer.js — the consuming AI agent for Credence's x402 service.
 *
 * Completes a REAL paid request end to end on Hedera testnet:
 *   1) unpaid GET  -> server answers 402 { accepts: [...] }
 *   2) the agent signs an HBAR transfer payload from its own wallet — no
 *      API key, no seats, no subscription
 *   3) retry with X-PAYMENT; the SERVER verifies + settles via Blocky402
 *   4) print the paid credit report + payment evidence + HashScan link
 *
 * Give the payer a few testnet HBAR via https://portal.hedera.com
 *
 * Usage: node x402/buyer.js <controller> [report|rate]
 *   (controller = 0x… address or <label>.agentcreditbureau.eth ENS name)
 *
 * Env:
 *   X402_SERVER_URL       default http://127.0.0.1:8787 (unified backend)
 *   X402_PAYER_ACCOUNT    default HEDERA_OPERATOR_ID
 *   X402_PAYER_KEY        default AGENT_PRIVATE_KEY (ECDSA secp256k1)
 *   X402_NETWORK          default hedera:testnet
 */
import { payFor, probeService, hashscanTx } from "./client.js";
import "dotenv/config";

async function runPaidRequest(service, controller) {
  const path = service === "rate" ? "factoring-rate" : "credit-report";

  // 1) unpaid probe -> expect 402
  console.log(`\n[1] discover: ${service} for ${controller}`);
  const { url, requirements } = await probeService(path, controller);
  console.log(`    unpaid GET  ${url}`);
  console.log(`    status 402 | requirements: ${JSON.stringify(requirements)}`);

  // 2+3) sign + retry (server verifies + settles via Blocky402)
  console.log(
    `[2] sign ${requirements.amount} tinybar payment from agent wallet -> ${requirements.payTo}`,
  );
  console.log("[3] retry with X-PAYMENT (server verifies+settles via Blocky402)");
  const paid = await payFor(path, controller);

  // 4) evidence
  console.log("[4] delivered:");
  console.log(JSON.stringify(paid, null, 2));
  const tx = paid?.payment?.transactionId;
  const link = hashscanTx(tx);
  if (link) {
    console.log(`\nHashScan — confirm the CRYPTOTRANSFER SUCCESS yourself:`);
    console.log(`  ${link}`);
  }
  console.log("\n✅ Paid request completed end to end on Hedera testnet.");
}

if (process.argv.length < 3) {
  console.error("Usage: node x402/buyer.js <controller> [report|rate]");
  process.exit(1);
}
const controller = process.argv[2];
const service = process.argv[3] || "report";

runPaidRequest(service, controller).catch((err) => {
  console.error(err.message);
  process.exit(1);
});