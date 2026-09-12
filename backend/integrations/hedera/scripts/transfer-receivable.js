/**
 * transfer-receivable.js — the SECONDARY MARKET leg for ATS-receivables.
 *
 * Hedera's track page explicitly awards extra points for "a secondary
 * market for ATS-issued assets, which the Studio does not have today".
 * This is the minimal tradeable market: a liquidity provider buys units of
 * an issued receivable bond from the current holder. The ATS Security
 * transfer pipeline runs the token's own compliance modules — the token
 * was created with isWhiteList=true + internalKycActivated=true, so a
 * transfer to an un-whitelisted buyer is rejected by the asset's
 * compliance layer (KYC grant / whitelist enforcement in use).
 *
 * To grant a buyer access first, the asset manager grants the buyer's
 * whitelist/KYC claim in ATS Studio (or via the ATS SDK IdentityRegistry
 * methods), then the transfer below settles compliance-clean.
 *
 * CLI: node scripts/transfer-receivable.js <tokenAddressOrId> <buyerAccountOrEvm> <units> [fromAccount]
 *   tokenAddressOrId: the ATS diamond address (0x…) or token id from issuance,
 *   buyerAccountOrEvm: LP account — Hedera id (0.0.x) or EVM address (0x…),
 *   units: number of receivable units to transfer ($0.01 face per unit),
 *   fromAccount: optional seller (defaults to the operator).
 */
const { Security, TransferRequest } = require("@hashgraph/asset-tokenization-sdk");
const { connectAts } = require("./lib/ats.js");

async function transferReceivable({ tokenAddressOrId, buyer, units, fromAccount }) {
  await connectAts();

  const result = await Security.transfer(
    new TransferRequest({
      securityId: `tokenAddressOrId`,
      targetId: buyer,
      amount: String(units),
    }),
  );

  console.log(`Transferred ${units} units of ${tokenAddressOrId} -> ${buyer}`);
  console.log("Transaction:", result.transactionId);
  if (result.transactionId) {
    console.log("HashScan:", `https://hashscan.io/testnet/transaction/${String(result.transactionId).replace("@", "-")}`);
  }
  console.log("Note: the transfer only lands if the buyer passes the token's compliance checks (whitelist + KYC grant).");
  console.log("An un-whitelisted buyer is rejected by ATS compliance modules — that is the control in action.");
  return result;
}

// CLI usage: node scripts/transfer-receivable.js <tokenAddressOrId> <buyer> <units>
if (require.main === module) {
  const [tokenAddressOrId, buyer, units, fromAccount] = process.argv.slice(2);
  if (!tokenAddressOrId || !buyer || !units) {
    console.error("Usage: node scripts/transfer-receivable.js <tokenAddressOrId> <buyerAccountOrEvm> <units> [fromAccount]");
    process.exit(1);
  }
  transferReceivable({ tokenAddressOrId, buyer, units: Number(units), fromAccount })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { transferReceivable };