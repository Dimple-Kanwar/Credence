/**
 * quote-factoring.js — the credit oracle view for a receivable.
 *
 * Pure read: pulls the agent's live score from CreditBureau (Sepolia),
 * prices the eligible discount off the same curve used at ATS issuance,
 * and prints the quote an LP would see. This is the "Oracle integration
 * for asset pricing or NAV" extra-point category: the oracle is the
 * on-chain CreditBureau -> The Graph report, and the price feeds both the
 * ATS bond issuance and the x402 pay-per-call factoring-rate service.
 *
 * CLI: node scripts/quote-factoring.js 0xAgentController [faceValueUsd]
 */
const { discountRateForScore, getAgentProfile } = require("./lib/ats.js");

async function quoteFactoring(controllerAddress, faceValueUsd = 1000) {
  const profile = await getAgentProfile(controllerAddress);
  const { ensName, score, frozen } = profile;
  const discountRate = frozen ? null : discountRateForScore(score);
  const eligible = !frozen && discountRate !== null;

  const quote = {
    agent: ensName,
    controller: profile.controller,
    score,
    tier:
      score >= 900 ? "Prime" :
      score >= 800 ? "Established" :
      score >= 650 ? "Building" :
      score >= 500 ? "New" : "Restricted",
    eligible,
    discountRate: eligible ? discountRate : null,
    discountPercent: eligible ? discountRate * 100 : null,
    faceValueUsd,
    pricedSaleUsd: eligible ? Number((faceValueUsd * (1 - discountRate)).toFixed(2)) : null,
    oracle: "CreditBureau (Sepolia) -> The Graph -> ATS pricing curve",
  };

  console.log(`Agent ${quote.agent} (${quote.controller})`);
  console.log(`Score ${quote.score} [${quote.tier}] | eligible: ${quote.eligible}`);
  if (eligible) {
    console.log(`$${quote.faceValueUsd} face value -> $${
      quote.pricedSaleUsd} at ${quote.discountPercent}% discount (LP buy price)`);
    console.log(`LP profit at maturity: $${(quote.faceValueUsd - quote.pricedSaleUsd).toFixed(2)}`);
  } else {
    console.log(frozen ? "Agent frozen — factoring blocked." : "Score below the 500 threshold.");
  }
  return quote;
}

if (require.main === module) {
  const [controllerAddress, faceValue] = process.argv.slice(2);
  if (!controllerAddress) {
    console.error("Usage: node scripts/quote-factoring.js <controllerAddress> [faceValueUsd=1000]");
    process.exit(1);
  }
  quoteFactoring(controllerAddress, faceValue ? Number(faceValue) : 1000)
    .then((q) => console.log("\nQuote:", JSON.stringify(q, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { quoteFactoring };