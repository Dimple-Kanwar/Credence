import { fetchFeePayer, verifyAndSettle } from "./facilitator.js";
import { getAgentReport, getFactoringRate } from "../../mcp/tools.js";

export const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com";
export const NETWORK = process.env.X402_NETWORK || "hedera:testnet";
export const ASSET = process.env.X402_ASSET || "0.0.0";
export const PAY_TO = process.env.X402_PAY_TO || process.env.HEDERA_OPERATOR_ID;
export const MAX_TIMEOUT_SECONDS = Number(process.env.X402_MAX_TIMEOUT_SECONDS || 90);
export const PRICES = {
  "credit-report": Number(process.env.X402_PRICE_REPORT_TINYBAR ?? 100),
  "factoring-rate": Number(process.env.X402_PRICE_RATE_TINYBAR ?? 50),
};

export function decodePaymentHeader(headers = {}) {
  const raw = headers["x-payment"] || headers["payment-signature"];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function requirementFor(priceTinybar) {
  const feePayer = await fetchFeePayer(FACILITATOR_URL);
  return {
    scheme: "exact",
    network: NETWORK,
    amount: String(priceTinybar),
    payTo: PAY_TO,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    asset: ASSET,
    extra: { feePayer },
  };
}

export async function gatePayment(headers, priceTinybar) {
  const requirements = await requirementFor(priceTinybar);
  const paymentPayload = decodePaymentHeader(headers);
  if (!paymentPayload) {
    return {
      status: 402,
      body: {
        x402Version: 2,
        accepts: [requirements],
        error: "PAYMENT_REQUIRED",
        note: "Pay exact HBAR on hedera:testnet via hosted Blocky402, then retry with X-PAYMENT",
      },
    };
  }

  const accepted = paymentPayload.accepted || requirements;
  if (
    String(accepted.amount) !== String(priceTinybar) ||
    accepted.payTo !== PAY_TO ||
    String(accepted.network) !== NETWORK
  ) {
    return {
      status: 402,
      body: { x402Version: 2, accepts: [requirements], error: "AMOUNT_OR_PAYTO_MISMATCH" },
    };
  }

  const settle = await verifyAndSettle(FACILITATOR_URL, paymentPayload, accepted);
  if (!settle.ok) {
    return {
      status: 402,
      body: {
        x402Version: 2,
        accepts: [requirements],
        error: settle.error,
        facilitator_claim: settle.claim,
        note: "Facilitator response is a claim, not independent ledger evidence",
      },
    };
  }
  return { status: 200, settle };
}

function paymentDetails(kind, settle) {
  return {
    facilitator: FACILITATOR_URL,
    transactionId: settle.transactionId,
    amountTinybar: PRICES[kind],
    note: "Settled on Hedera testnet via Blocky402. Confirm SUCCESS on HashScan/Mirror.",
  };
}

export async function paidCreditReport(controller, headers) {
  const gate = await gatePayment(headers, PRICES["credit-report"]);
  if (gate.status !== 200) return gate;
  const report = await getAgentReport(controller);
  return {
    status: 200,
    body: {
      service: "credence/credit-report",
      ...report,
      score: Number(report.score),
      payment: paymentDetails("credit-report", gate.settle),
    },
  };
}

export async function paidFactoringRate(controller, headers) {
  const gate = await gatePayment(headers, PRICES["factoring-rate"]);
  if (gate.status !== 200) return gate;
  const result = await getFactoringRate(controller);
  return {
    status: 200,
    body: {
      service: "credence/factoring-rate",
      ...result,
      oracle: "CreditBureau -> The Graph -> ATS pricing curve (1% Prime .. 15% New)",
      payment: paymentDetails("factoring-rate", gate.settle),
    },
  };
}

export function serviceIndex() {
  return `Credence x402 service — pay-per-call credit intelligence on Hedera testnet
Facilitator: ${FACILITATOR_URL} (Blocky402) | network: ${NETWORK} | asset: ${ASSET}

  GET /credit-report/:controller    ${PRICES["credit-report"]} tinybar
  GET /factoring-rate/:controller   ${PRICES["factoring-rate"]} tinybar

Use the X-PAYMENT header after probing either endpoint for its 402 payment requirements.
`;
}

export function serviceHealth() {
  return { ok: true, network: NETWORK, facilitator: FACILITATOR_URL, payTo: PAY_TO || null };
}
