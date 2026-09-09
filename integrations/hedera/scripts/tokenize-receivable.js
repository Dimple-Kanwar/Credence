/**
 * tokenize-receivable.js
 *
 * Hedera "Tokenization of Anything" track.
 *
 * Idea: once an agent has a live credit score (from CreditBureau, indexed
 * by The Graph), its outstanding receivables — invoices it is OWED by
 * counterparties for completed jobs — can be tokenized via Hedera's Asset
 * Tokenization Studio (ATS) and sold to liquidity providers at a discount.
 * The discount rate is priced directly off the agent's score:
 *
 *   score >= 900  -> 1% discount  (near risk-free)
 *   score >= 800  -> 3% discount
 *   score >= 650  -> 7% discount
 *   score >= 500  -> 15% discount
 *   score <  500  -> not eligible for factoring
 *
 * This mirrors Hedera's own suggested idea ("cashflow tokenisation:
 * invoices, receivables, or royalty streams sold at a discount and settled
 * on maturity") but makes the discount rate a function of an on-chain,
 * Graph-indexed reputation score instead of a manual underwriting call.
 *
 * Docs:
 *   ATS monorepo: https://github.com/hashgraph/asset-tokenization-studio
 *   ATS SDK:      https://www.npmjs.com/package/@hashgraph/asset-tokenization-sdk
 *
 * NOTE: ATS SDK method names below follow the documented bond/equity
 * issuance pattern (ERC-1400 security-token style). Confirm exact call
 * signatures against the SDK version pulled in at build time — the ATS
 * public API surface has been evolving.
 */

const { Client, PrivateKey } = require("@hashgraph/sdk");
const {
  CreateEquityRequest,
  Equity,
  Network,
  ConnectRequest,
  SupportedWallets,
} = require("@hashgraph/asset-tokenization-sdk");
const { ethers } = require("ethers");
require("dotenv").config();

const CREDIT_BUREAU_ABI = [
  "function getProfile(address controller) external view returns (tuple(string ensName, address controller, bool humanBacked, bool registered, bool frozen, uint32 score, uint256 spendLimitWei, uint32 totalTx, uint32 successTx, uint32 lateTx, uint32 disputedTx, uint32 defaultTx))",
];

function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null; // not eligible for factoring
}

async function getAgentScore(controllerAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const bureau = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, provider);
  const profile = await bureau.getProfile(controllerAddress);
  return {
    ensName: profile.ensName,
    score: Number(profile.score),
    frozen: profile.frozen,
  };
}

async function tokenizeReceivable({ controllerAddress, invoiceFaceValueUsd, maturityDays }) {
  const { ensName, score, frozen } = await getAgentScore(controllerAddress);

  if (frozen) {
    throw new Error(`Agent ${ensName} is frozen — not eligible for receivable factoring.`);
  }

  const discountRate = discountRateForScore(score);
  if (discountRate === null) {
    throw new Error(`Agent ${ensName} score (${score}) is below the factoring threshold (500).`);
  }

  const discountedPrice = invoiceFaceValueUsd * (1 - discountRate);

  console.log(`Agent: ${ensName} | score: ${score} | discount rate: ${discountRate * 100}%`);
  console.log(`Face value: $${invoiceFaceValueUsd} -> tokenized sale price: $${discountedPrice.toFixed(2)}`);
  console.log(`Maturity: ${maturityDays} days`);

  const requiredEnv = [
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_KEY",
    "ATS_FACTORY_ADDRESS",
    "ATS_RESOLVER_ADDRESS",
  ];
  for (const name of requiredEnv) {
    if (!process.env[name] || process.env[name].includes("xxxxx")) {
      throw new Error(`Set ${name} before issuing an ATS receivable token`);
    }
  }

  const client = Client.forTestnet();
  client.setOperator(
    process.env.HEDERA_OPERATOR_ID,
    PrivateKey.fromStringECDSA(process.env.HEDERA_OPERATOR_KEY)
  );

  await Network.setConfig({
    factoryAddress: process.env.ATS_FACTORY_ADDRESS,
    resolverAddress: process.env.ATS_RESOLVER_ADDRESS,
  });
  await Network.connect(new ConnectRequest({
    account: {
      accountId: process.env.HEDERA_OPERATOR_ID,
      privateKey: { key: process.env.HEDERA_OPERATOR_KEY, type: "ECDSA" },
    },
    network: "testnet",
    wallet: SupportedWallets.METAMASK,
    mirrorNode: { baseUrl: "https://testnet.mirrornode.hedera.com/api/v1/" },
    rpcNode: { baseUrl: process.env.HEDERA_RPC_URL || "https://testnet.hashio.io/api" },
  }));

  const token = await Equity.create(new CreateEquityRequest({
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
    votingRight: false,
    informationRight: true,
    liquidationRight: false,
    subscriptionRight: false,
    conversionRight: false,
    redemptionRight: true,
    putRight: false,
    dividendRight: 0,
    currency: "0x555344",
    numberOfShares: String(Math.round(invoiceFaceValueUsd * 100)),
    nominalValue: "100",
    regulationType: 0,
    regulationSubType: 0,
    isCountryControlListWhiteList: true,
    countries: "",
    info: JSON.stringify({ maturityDays, discountRate, agent: ensName }),
    configId: `0x${"0".repeat(64)}`,
    configVersion: 1,
  }));

  console.log("Tokenized receivable created:", token.security.evmDiamondAddress);

  return {
    ensName,
    score,
    discountRate,
    faceValueUsd: invoiceFaceValueUsd,
    discountedPriceUsd: Number(discountedPrice.toFixed(2)),
    maturityDays,
    transactionId: token.transactionId,
    tokenAddress: token.security.evmDiamondAddress,
  };
}

// CLI usage: node tokenize-receivable.js 0xAgentController 1000 30
if (require.main === module) {
  const [controllerAddress, faceValue, maturity] = process.argv.slice(2);
  if (!controllerAddress || !faceValue) {
    console.error("Usage: node tokenize-receivable.js <controllerAddress> <invoiceFaceValueUsd> [maturityDays=30]");
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
