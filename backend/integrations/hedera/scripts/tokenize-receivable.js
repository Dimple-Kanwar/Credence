/**
 * tokenize-receivable.js
 *
 * Hedera "Tokenization of Anything" track — ISSUANCE leg.
 *
 * Once an agent has a live credit score (from CreditBureau, indexed by
 * The Graph), its outstanding receivables — invoices it is OWED by
 * counterparties for completed jobs — are tokenized as ZERO-COUPON BONDS
 * on Hedera's Asset Tokenization Studio (ATS). A liquidity provider buys
 * them at a discount priced directly off the agent's score, then redeems
 * face value at maturity:
 *
 *   score >= 900  -> 1% discount  (Prime — near risk-free)
 *   score >= 800  -> 3% discount  (Established)
 *   score >= 650  -> 7% discount  (Building)
 *   score >= 500  -> 15% discount (New)
 *   score <  500  -> not eligible for factoring
 *
 * This is the "Cashflow tokenisation: invoices, receivables, or royalty
 * streams sold at a discount and settled on maturity" idea from the Hedera
 * track page, but the discount is a function of an on-chain, Graph-indexed
 * reputation score instead of a manual underwriting call. The score is the
 * pricing oracle; the ATS bond is the tradable asset.
 *
 * A bond (not a plain equity) is the right instrument for a receivable:
 * it carries a maturity date, supports redemption at maturity, and can pay
 * coupons / royalties through ATS — i.e. real lifecycle management, which
 * the track explicitly favours ("Real asset classes and real lifecycle
 * management will be favoured over a token with a name on it").
 *
 * Lifecycle after issuance (see scripts/):
 *   node scripts/transfer-receivable.js <tokenId> <lpAccount> <units>   LP purchase (compliance-enforced)
 *   node scripts/redeem-at-maturity.js <tokenId> <holderAccount>        redemption at maturity
 *   node scripts/schedule-maturity-settlement.js <tokenId> <daysFromNow> scheduled payout at maturity
 *
 * CLI: node scripts/tokenize-receivable.js 0xAgentController 1000 30
 */

const { CreateBondRequest, Bond } = require("@hashgraph/asset-tokenization-sdk");
const {
  discountRateForScore,
  getAgentProfile,
  connectAts,
  maturityTimestamp,
} = require("./lib/ats.js");

async function tokenizeReceivable({ controllerAddress, invoiceFaceValueUsd, maturityDays }) {
  const profile = await getAgentProfile(controllerAddress);
  const { ensName, score, frozen } = profile;

  if (frozen) {
    throw new Error(`Agent ${ensName} is frozen — not eligible for receivable factoring.`);
  }

  const discountRate = discountRateForScore(score);
  if (discountRate === null) {
    throw new Error(`Agent ${ensName} score (${score}) is below the factoring threshold (500).`);
  }

  const faceValueUsd = invoiceFaceValueUsd;
  const discountedPriceUsd = Number((faceValueUsd * (1 - discountRate)).toFixed(2));
  const now = Math.floor(Date.now() / 1000);
  const maturity = maturityTimestamp(maturityDays);

  console.log(`Agent: ${ensName} | score: ${score} | discount rate: ${discountRate * 100}%`);
  console.log(`Face value: $${faceValueUsd} -> tokenized sale price: $${discountedPriceUsd}`);
  console.log(`Maturity: ${new Date(Number(maturity) * 1000).toISOString()} (${maturityDays} days)`);

  await connectAts();

  // Zero-coupon bond: $0.01 (=1 unit) per invoice cent — face value == units total.
  const token = await Bond.create(
    new CreateBondRequest({
      name: `Receivable - ${ensName}`,
      symbol: "AGRV",
      isin: `AGRV${Date.now().toString().slice(-8)}`,
      decimals: 2,
      isWhiteList: true,
      erc20VotesActivated: false,
      isControllable: true,
      arePartitionsProtected: false,
      isMultiPartition: false,
      clearingActive: false,
      internalKycActivated: true,
      currency: "0x555344", // USD
      numberOfUnits: String(Math.round(faceValueUsd * 100)),
      nominalValue: "1",
      startingDate: String(now), // unix seconds
      maturityDate: maturity, // unix seconds
      regulationType: 0,
      regulationSubType: 0,
      isCountryControlListWhiteList: true,
      countries: "",
      info: JSON.stringify({
        kind: "receivable",
        maturityDays,
        discountRate,
        faceValueUsd,
        agent: ensName,
        controller: profile.controller,
        score,
      }),
      configId: `0x${"0".repeat(64)}`,
      configVersion: 1,
    }),
  );

  const result = {
    kind: "receivable-bond",
    ensName,
    controller: profile.controller,
    score,
    discountRate,
    faceValueUsd,
    discountedPriceUsd,
    maturityDays,
    transactionId: token.transactionId,
    tokenAddress: token.security.evmDiamondAddress,
  };
  console.log("Bond-issued receivable:", result.tokenAddress);
  if (result.transactionId) {
    console.log("HashScan:", `https://hashscan.io/testnet/transaction/${String(result.transactionId).replace("@", "-")}`);
  }
  return result;
}

// CLI usage: node scripts/tokenize-receivable.js 0xAgentController 1000 30
if (require.main === module) {
  const [controllerAddress, faceValue, maturity] = process.argv.slice(2);
  if (!controllerAddress || !faceValue) {
    console.error("Usage: node scripts/tokenize-receivable.js <controllerAddress> <invoiceFaceValueUsd> [maturityDays=30]");
    process.exit(1);
  }
  tokenizeReceivable({
    controllerAddress,
    invoiceFaceValueUsd: Number(faceValue),
    maturityDays: Number(maturity || 30),
  })
    .then((result) => console.log("Result:", result))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { tokenizeReceivable, discountRateForScore };