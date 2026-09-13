/**
 * schedule-maturity-settlement.js — Hedera Scheduled Transactions for
 * receivable maturity settlement.
 *
 * Hedera's track page awards extra points for "Scheduled Transactions for
 * vesting, coupon payments, or maturity settlement". Hedera is the only
 * mainstream L1 with native transaction scheduling, so this is a
 * Hedera-specific lifecycle feature: the maturity settlement is written
 * ahead of time as a SCHEDULED transaction — nobody has to be online at
 * maturity for the receivable to pay out.
 *
 * Two modes:
 *   contract  (default) schedule the ATS bond's own on-chain redemption
 *             (redeemAtMaturityByPartition on the bond diamond) — the
 *             lifecycle operation itself is auto-executed at maturity.
 *   transfer  schedule the plain cash leg — HbarTransfer from the borrower
 *             (operator) to the LP holder at maturity.
 *
 * CLI: node scripts/schedule-maturity-settlement.js <tokenAddressOrEvmId> <lpAccount> <units> [mode=contract] [executeAtUnixSeconds]
 */
const {
  Client,
  PrivateKey,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  TransferTransaction,
  Hbar,
  ScheduleCreateTransaction,
  ContractId,
} = require("@hashgraph/sdk");
const { connectAts } = require("./lib/ats.js");
const { hashscanUrl } = require("./lib/hashscan.js");

const EXECUTE_METHOD = "redeemAtMaturityByPartition";
const DEFAULT_PARTITION = `0x${"0".repeat(64)}`;

async function resolveContractId(evmAddress) {
  try {
    const res = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/contracts/${evmAddress.toLowerCase()}`,
    );
    if (res.ok) {
      const data = await res.json();
      if (data.contract_id) return ContractId.fromString(data.contract_id);
    }
  } catch {
    /* fall through to direct EVM decode */
  }
  return ContractId.fromEvmAddress(0, 0, evmAddress.replace(/^0x/, ""));
}

async function scheduleMaturitySettlement({
  tokenAddress,
  lpAccount,
  units,
  mode = "contract",
  executeAtUnixSeconds,
}) {
  const { client, operatorId } = await connectAts();

  let scheduleMemo = "Credence receivable maturity settlement";
  let scheduledTransaction;
  let scheduledTxId;

  if (mode === "contract") {
    // Inner tx: call redeemAtMaturityByPartition(bytes32 securityId,
    // address sourceId, bytes32 partitionId, uint256 amount) on the bond
    // diamond at maturity. The bond's own compliance will release proceeds.
    const contractId = await resolveContractId(tokenAddress);
    scheduledTransaction = new ContractExecuteTransaction()
      .setContractId(contractId)
      .setFunction(
        EXECUTE_METHOD,
        new ContractFunctionParameters()
          .addBytes32(tokenAddress.toLowerCase().replace(/^0x/, "").padStart(64, "0"))
          .addAddress(lpAccount)
          .addBytes32(DEFAULT_PARTITION.replace(/^0x/, ""))
          .addUint256(units),
      )
      .setGas(400000);
    scheduledTxId = `${EXECUTE_METHOD} on ${contractId}`;
    scheduleMemo = `Credence ATS receivable redemption (${units} units) at maturity`;
  } else {
    // Inner tx: cash leg — borrower (operator) pays the LP face value at
    // maturity. units face $0.01 each -> tinybar = units (1:1 with cents is
    // illustrative; real deployments settle via the bond's currency).
    scheduledTransaction = new TransferTransaction()
      .addHbarTransfer(operatorId, new Hbar(-units / 100))
      .addHbarTransfer(lpAccount, new Hbar(units / 100));
    scheduledTxId = `HbarTransfer ${units / 100} HBAR -> ${lpAccount}`;
    scheduleMemo = `Credence receivable cash settlement ($${units / 100} face) at maturity`;
  }

  const schedule = new ScheduleCreateTransaction()
    .setScheduledTransaction(scheduledTransaction)
    .setScheduleMemo(scheduleMemo)
    .setPayerAccountId(operatorId);

  if (executeAtUnixSeconds) {
    // schedule only becomes executable from this consensus time
    schedule.setWaitForExpiry(true).setExpirationTime(
      new Date(Number(executeAtUnixSeconds) * 1000),
    );
  }

  const response = await schedule.execute(client);
  const receipt = await response.getReceipt(client);
  const scheduleId = receipt.scheduleId.toString();

  console.log(`Scheduled: ${scheduledTxId}`);
  console.log(`Schedule ID: ${scheduleId}`);
  console.log(`Memo: ${scheduleMemo}`);
  const url = await hashscanUrl(String(response.transactionId));
  if (url) console.log("HashScan:", url);

  return {
    mode,
    scheduleId,
    scheduleTxId: String(response.transactionId),
    scheduledTransaction: scheduledTxId,
    executeAtUnixSeconds: executeAtUnixSeconds || null,
    note:
      "Trigger execution at/after maturity from any Hedera client (schedule sign/execute); " +
      "the scheduled receipt will show the settlement result.",
  };
}

if (require.main === module) {
  const [tokenAddress, lpAccount, units, mode, executeAt] = process.argv.slice(2);
  if (!tokenAddress || !units) {
    console.error(
      "Usage: node scripts/schedule-maturity-settlement.js <tokenAddressOrEvmId> <lpAccountOrEvm> <units> [mode=contract|transfer] [executeAtUnixSeconds]",
    );
    process.exit(1);
  }
  scheduleMaturitySettlement({
    tokenAddress,
    lpAccount: lpAccount || "",
    units: Number(units),
    mode: mode || "contract",
    executeAtUnixSeconds: executeAt ? Number(executeAt) : undefined,
  })
    .then((r) => console.log("\nResult:", JSON.stringify(r, null, 2)))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { scheduleMaturitySettlement };