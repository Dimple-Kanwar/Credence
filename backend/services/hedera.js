const { resolveController } = require("./mcp.js");
const { HOST, PORT } = require("../config.js");

async function tokenize(payload) {
  let tokenizeReceivable;
  try {
    ({ tokenizeReceivable } = require("../integrations/hedera/scripts/tokenize-receivable.js"));
  } catch (error) {
    throw new Error(`Hedera integration is unavailable: ${error.message}`);
  }
  const controllerAddress = await resolveController(payload.controller);
  return tokenizeReceivable({
    controllerAddress,
    invoiceFaceValueUsd: Number(payload.faceValueUsd),
    maturityDays: Number(payload.maturityDays || 30),
  });
}

async function payFor(servicePath, controller) {
  const x402 = await import("../integrations/hedera/x402/client.js");
  const body = await x402.payFor(servicePath, controller);
  return { ...body, payerWallet: x402.readPayerConfig().account };
}

async function service() {
  return import("../integrations/hedera/x402/service.js");
}

async function mirrorBalance(accountId) {
  if (!accountId || !/^0\.0\.\d+$/.test(accountId)) return null;
  try {
    const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(accountId)}`);
    if (!response.ok) return null;
    const data = await response.json();
    return (Number(data.balance?.balance) || 0) / 1e8;
  } catch {
    return null;
  }
}

async function status() {
  const x402 = await import("../integrations/hedera/x402/client.js");
  const payer = { configured: false };
  try {
    const config = x402.readPayerConfig();
    payer.configured = Boolean(config.account);
    payer.account = config.account;
  } catch {
    // The payer is optional for read-only backend operation.
  }

  const operatorBalance = await mirrorBalance(process.env.HEDERA_OPERATOR_ID);
  payer.balanceHbar = payer.account ? await mirrorBalance(payer.account) : null;
  let x402Server = null;
  try {
    const probe = await fetch(`${process.env.X402_SERVER_URL || `http://${HOST}:${PORT}`}/credit-report/health`);
    x402Server = probe.ok ? await probe.json() : { reachable: false };
  } catch {
    x402Server = { reachable: false, error: "unreachable" };
  }

  return {
    operatorConfigured: Boolean(
      process.env.HEDERA_OPERATOR_ID &&
      process.env.HEDERA_OPERATOR_KEY &&
      !String(process.env.HEDERA_OPERATOR_ID).includes("xxx") &&
      !String(process.env.HEDERA_OPERATOR_ID).includes("...") &&
      String(process.env.HEDERA_OPERATOR_KEY).length > 20 &&
      !String(process.env.HEDERA_OPERATOR_KEY).includes("xxx") &&
      Number(operatorBalance) > 0.5
    ),
    operatorId: process.env.HEDERA_OPERATOR_ID || null,
    operatorBalanceHbar: operatorBalance,
    atsConfigured: Boolean(
      process.env.ATS_FACTORY_ADDRESS &&
      process.env.ATS_RESOLVER_ADDRESS &&
      !String(process.env.ATS_FACTORY_ADDRESS).includes("...")
    ),
    payer,
    x402Server,
    facilitator: process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com",
  };
}

async function quote(payload) {
  const { quoteFactoring } = require("../integrations/hedera/scripts/quote-factoring.js");
  const controllerAddress = await resolveController(payload.controller);
  return quoteFactoring(controllerAddress, Number(payload.faceValueUsd || 1000));
}

async function transfer(payload) {
  const { transferReceivable } = require("../integrations/hedera/scripts/transfer-receivable.js");
  return transferReceivable({
    tokenAddressOrId: payload.tokenAddress,
    buyer: payload.lpAccount || payload.buyer,
    units: Number(payload.units),
  });
}

async function schedule(payload) {
  const { scheduleMaturitySettlement } = require("../integrations/hedera/scripts/schedule-maturity-settlement.js");
  return scheduleMaturitySettlement({
    tokenAddress: payload.tokenAddress,
    lpAccount: payload.lpAccount,
    units: Number(payload.units),
    mode: payload.mode || "contract",
    executeAtUnixSeconds: payload.executeAtUnixSeconds ? Number(payload.executeAtUnixSeconds) : undefined,
  });
}

async function redeem(payload) {
  const { redeemAtMaturity } = require("../integrations/hedera/scripts/redeem-at-maturity.js");
  return redeemAtMaturity({
    tokenAddressOrId: payload.tokenAddress,
    holder: payload.holder || payload.lpAccount,
    units: Number(payload.units),
  });
}

module.exports = { payFor, quote, redeem, schedule, service, status, tokenize, transfer };
