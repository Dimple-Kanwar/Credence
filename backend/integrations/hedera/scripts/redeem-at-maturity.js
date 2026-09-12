/**
 * redeem-at-maturity.js — REDEMPTION leg of the receivable lifecycle.
 *
 * The LP who bought the receivable bond redeems it at (or after) maturity
 * for face value. ATS Bond.redeemAtMaturityByPartition performs the
 * lifecycle operation on-chain; the proceeds flow to the bond's
 * proceed-recipient configuration.
 *
 * CLI: node scripts/redeem-at-maturity.js <tokenAddressOrId> <holderAccountOrEvm> <units>
 *   holderAccountOrEvm: the LP / holder account (Hedera 0.0.x or EVM 0x…)
 *   units: receivable units to redeem (face $0.01 per unit)
 */
const { Bond, RedeemAtMaturityByPartitionRequest } = require("@hashgraph/asset-tokenization-sdk");
const { connectAts } = require("./lib/ats.js");

// ERC-3643/1400 security tokens use a single default partition.
const DEFAULT_PARTITION = `0x${"0".repeat(64)}`;

async function redeemAtMaturity({ tokenAddressOrId, holder, units }) {
  await connectAts();

  const result = await Bond.redeemAtMaturityByPartition(
    new RedeemAtMaturityByPartitionRequest({
      securityId: tokenAddressOrId,
      partitionId: DEFAULT_PARTITION,
      sourceId: holder,
      amount: String(units),
    }),
  );

  console.log(`Redeemed ${units} units of ${tokenAddressOrId} held by ${holder} at maturity.`);
  console.log("Transaction:", result.transactionId);
  if (result.transactionId) {
    console.log("HashScan:", `https://hashscan.io/testnet/transaction/${String(result.transactionId).replace("@", "-")}`);
  }
  return result;
}

if (require.main === module) {
  const [tokenAddressOrId, holder, units] = process.argv.slice(2);
  if (!tokenAddressOrId || !holder || !units) {
    console.error("Usage: node scripts/redeem-at-maturity.js <tokenAddressOrId> <holderAccountOrEvm> <units>");
    process.exit(1);
  }
  redeemAtMaturity({ tokenAddressOrId, holder, units: Number(units) })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { redeemAtMaturity, DEFAULT_PARTITION };