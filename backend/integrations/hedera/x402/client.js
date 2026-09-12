/**
 * client.js — x402 client helpers for Credence's Hedera service.
 *
 * Shared by buyer.js (single paid request) and agent-demo.js (discover ->
 * pay -> consume -> act loop). Implements the x402 v2 exact-Hedera flow:
 *   1) GET the service unpaid  -> 402 { accepts: [requirements] }
 *   2) sign an HBAR transfer payload from the agent wallet
 *   3) retry with X-PAYMENT (the resource server verifies + settles via
 *      Blocky402 — the client NEVER settles)
 *   4) return the paid payload + payment tx evidence
 */
import {
  createClientHederaSigner,
  ExactHederaScheme,
  PrivateKey,
  Transaction,
} from "@x402/hedera";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Load the repo-root .env (and any local .env) regardless of cwd.
const __here = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [path.join(__here, ".env")];
for (let i = 0; i < 5; i++) envCandidates.push(path.join(__here, ...Array(i + 1).fill(".."), ".env"));
dotenv.config({ path: envCandidates });

export const SERVER_URL = process.env.X402_SERVER_URL || "http://127.0.0.1:8787";
export const NETWORK = process.env.X402_NETWORK || "hedera:testnet";

export function readPayerConfig() {
  const account = process.env.X402_PAYER_ACCOUNT || process.env.HEDERA_OPERATOR_ID;
  const key = process.env.X402_PAYER_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!account || !key || key.includes("xxxxx") || key.includes("302e") && key.length < 40) {
    throw new Error(
      "Set X402_PAYER_ACCOUNT (0.0.x testnet agent wallet with testnet HBAR) and " +
        "X402_PAYER_KEY (or HEDERA_OPERATOR_ID / AGENT_PRIVATE_KEY). Top up at https://portal.hedera.com",
    );
  }
  return { account, key };
}

const BASE = SERVER_URL.replace(/\/$/, "");

/**
 * Discover the service: probe `path` unpaid, expect a 402 describing the
 * exact payment the server will accept.
 */
export async function probeService(path, controller) {
  const url = `${BASE}/${path}/${encodeURIComponent(controller)}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) {
    const requirements = body.accepts?.[0];
    if (!requirements) throw new Error("402 response missing accepts[0]");
    return { url, requirements };
  }
  if (res.status === 200) {
    throw new Error(`Service answered without payment (unexpected for ${path})`);
  }
  throw new Error(`Service probe failed: HTTP ${res.status} ${JSON.stringify(body)}`);
}

/** Sign an HBAR transfer satisfying `requirements` (exact scheme). */
export async function signPayment(requirements) {
  const { account, key } = readPayerConfig();
  const signer = createClientHederaSigner(account, PrivateKey.fromStringECDSA(key), {
    network: NETWORK,
  });
  const scheme = new ExactHederaScheme(signer);
  const signed = await scheme.createPaymentPayload(2, requirements);
  const parsed = Transaction.fromBytes(Buffer.from(signed.payload.transaction, "base64"));
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    accepted: requirements,
    payload: signed.payload,
  };
  return {
    paymentPayload,
    xPayment: Buffer.from(JSON.stringify(paymentPayload)).toString("base64"),
    signedTxType: parsed.constructor.name,
    signedTxId: String(parsed.transactionId),
  };
}

/** Pay for one service call and return the delivered payload. */
export async function payFor(path, controller) {
  const { url, requirements } = await probeService(path, controller);
  console.log(
    `  -> paying ${requirements.amount} tinybar: ${requirements.network} ${requirements.asset} -> ${requirements.payTo}`,
  );
  const { xPayment } = await signPayment(requirements);
  const res = await fetch(url, { headers: { "X-PAYMENT": xPayment } });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    throw new Error(
      `Paid request rejected: HTTP ${res.status} ${JSON.stringify(body)}` +
        "\n(If INSUFFICIENT_ACCOUNT_BALANCE: top up the payer at https://portal.hedera.com and retry.)",
    );
  }
  return body;
}

/** HashScan link for a Hedera tx id. */
export function hashscanTx(txId) {
  if (!txId) return null;
  return `https://hashscan.io/testnet/transaction/${String(txId).replace("@", "-")}`;
}