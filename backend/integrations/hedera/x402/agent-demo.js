/**
 * agent-demo.js — an autonomous agent that discovers, pays for, consumes,
 * and ACTS on Credence's x402 services — machine-speed credit decisions.
 *
 * This is the demo that matches the Hedera track's brief: "Show an agent
 * discovering the service and paying for it without an API key or a
 * subscription in sight." It runs in a loop:
 *
 *   1) discovers /credit-report:<controller>   -> pays  100 tinybar (HBAR)
 *   2) discovers /factoring-rate:<controller>  -> pays   50 tinybar (HBAR)
 *   3) acts: turns the paid reports into a credit decision + ATS
 *      eligibility ("approve / monitor / decline") — exactly what the
 *      Graph analyst recommends, now delivered over a metered HBAR rail.
 *
 * Every step leaves on-ledger evidence (HashScan tx per call) and no API
 * key exists anywhere on the consuming side.
 *
 * Run (needs the x402 server up + a funded testnet payer wallet):
 *   npm run backend &
 *   node x402/agent-demo.js 0xAgentController
 */
import { payFor, hashscanTx } from "./client.js";
import "dotenv/config";

function decisionFrom(report) {
  const { recommendation } = report;
  if (!recommendation) return { decision: "UNDETERMINED" };
  return {
    decision: recommendation.decision, // approve | monitor | decline
    evidence: (recommendation.evidence || []).slice(0, 4),
    recommendedLimitWei: recommendation.recommendedLimitWei,
  };
}

async function runAgentDemo(controller) {
  console.log(`\n=== Credence agent paying its own way on Hedera (${controller}) ===\n`);

  // 1) pay for the live credit report
  console.log("[1/3] credit-report (100 tinybar)");
  const report = await payFor("credit-report", controller);
  console.log(`      ${report.ensName} score ${report.score} [${report.tier}]`);
  console.log(`      paid tx ${await hashscanTx(report.payment?.transactionId)}`);

  // 2) pay for the factoring-rate quote (credit oracle pricing)
  console.log("[2/3] factoring-rate (50 tinybar)");
  const quote = await payFor("factoring-rate", controller);
  console.log(
    `      eligible ${quote.eligible} | discount ${quote.discountPercent ?? "—"}%`,
  );
  console.log(`      paid tx ${await hashscanTx(quote.payment?.transactionId)}`);

  // 3) act on what was paid for — a real decision with spend + ATS state
  console.log("[3/3] decision");
  const decision = decisionFrom(report);
  const summary = {
    controller,
    ensName: report.ensName,
    score: report.score,
    decision: decision.decision,
    recommendedLimitWei: decision.recommendedLimitWei,
    factoringEligible: quote.eligible,
    factoringDiscountPercent: quote.discountPercent,
    payableIn: "HBAR (100+50 tinybar per cycle, no API key)",
    evidence: decision.evidence,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n✅ Agent discovered, paid per-call, consumed, and decided — all on Hedera.");

  return summary;
}

if (process.argv.length < 3) {
  console.error("Usage: node x402/agent-demo.js <controller>");
  process.exit(1);
}
runAgentDemo(process.argv[2]).catch((err) => {
  console.error(err.message);
  process.exit(1);
});