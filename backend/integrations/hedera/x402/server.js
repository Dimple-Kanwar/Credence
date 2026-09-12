/**
 * server.js — Credence x402 service on Hedera (ETHOnline: "AI & Agentic
 * Payments on Hedera").
 *
 * Stands up a REAL x402-gated service on Hedera testnet, settled through the
 * hosted Blocky402 facilitator. No API keys, no seats, no subscriptions:
 * an AI agent pays a few tinybar per call from its own wallet and gets the
 * live Credence credit report.
 *
 *   GET /                               service index (agent-discovery page)
 *   GET /health                         liveness
 *   GET /credit-report/:controller      100 tinybar -> live AI credit report
 *   GET /factoring-rate/:controller      50 tinybar -> score-priced ATS quote
 *
 * Flow (x402 v2, exact scheme, Hedera):
 *   1) unpaid GET            -> 402 { accepts: [{ scheme:"exact", network,
 *                                amount, payTo, asset, extra:{ feePayer } }] }
 *   2) agent signs HBAR transfer to payTo (fee payer from Blocky402) and
 *      retries with X-PAYMENT: base64(paymentPayload)
 *   3) this server verifies + settles via Blocky402 (server holds NO key)
 *   4) Mirror-node cross-check on DUPLICATE settle, then delivers the report
 *
 * The report delivered here is the SAME Graph-indexed report that prices the
 * agent's receivable tokenization on ATS — payment rail and tokenization
 * rail share one ledger and one credit oracle.
 *
 * Run:
 *   HEDERA_OPERATOR_ID=0.0.x X402_PAY_TO=0.0.x GRAPH_ENDPOINT=... \
 *   node x402/server.js
 *
 * Consume (agent side):
 *   node x402/buyer.js 0xAgentController report
 */
import express from "express";
import { analyzeAgent } from "../../graph/credit-analyst.js";
import { resolveController, scoreTier } from "../../mcp/tools.js";
import { fetchFeePayer, verifyAndSettle } from "./facilitator.js";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Load the repo-root .env (and any local .env) regardless of cwd.
const __here = path.dirname(fileURLToPath(import.meta.url));
const envCandidates = [path.join(__here, ".env")];
for (let i = 0; i < 5; i++) envCandidates.push(path.join(__here, ...Array(i + 1).fill(".."), ".env"));
dotenv.config({ path: envCandidates });

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://api.testnet.blocky402.com";
const NETWORK = process.env.X402_NETWORK || "hedera:testnet";
const ASSET = process.env.X402_ASSET || "0.0.0"; // HBAR on Hedera
const PAY_TO = process.env.X402_PAY_TO || process.env.HEDERA_OPERATOR_ID;
const MAX_TIMEOUT_SECONDS = Number(process.env.X402_MAX_TIMEOUT_SECONDS || 90);
const PRICES = {
  "credit-report": Number(process.env.X402_PRICE_REPORT_TINYBAR ?? 100), // 0.0001 HBAR
  "factoring-rate": Number(process.env.X402_PRICE_RATE_TINYBAR ?? 50), // 0.00005 HBAR
};

const app = express();
app.use(express.json());

/** x402 discount tiers — same oracle as ATS issuance (see scripts/). */
function discountRateForScore(score) {
  if (score >= 900) return 0.01;
  if (score >= 800) return 0.03;
  if (score >= 650) return 0.07;
  if (score >= 500) return 0.15;
  return null;
}

function decodePaymentHeader(req) {
  const raw =
    req.headers["x-payment"] ||
    req.headers["X-PAYMENT"] ||
    req.headers["payment-signature"] ||
    req.headers["PAYMENT-SIGNATURE"];
  if (!raw) return null;
  try {
    return JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Build the 402 accept requirement the buyer must satisfy. */
async function requirementFor(priceTinybar) {
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

/**
 * x402 gate: unpaid -> 402 with `accepts`; paid -> verify+settle via
 * Blocky402 and hand the payload builder the green light. The server never
 * touches a private key; payment proof is the facilitator's settle claim
 * (+ Mirror cross-check on duplicates).
 */
async function gatePayment(req, priceTinybar) {
  const requirements = await requirementFor(priceTinybar);
  const paymentPayload = decodePaymentHeader(req);
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

// ---------------------------------------------------------------------------
// GET / — agent-facing service index (the "marketplace discovery" leg).
// ---------------------------------------------------------------------------
app.get("/", (_req, res) => {
  res.type("text").send(`
Credence x402 service — pay-per-call credit intelligence on Hedera testnet
Facilitator: ${FACILITATOR_URL} (Blocky402) | network: ${NETWORK} | asset: ${ASSET}

  GET /credit-report/:controller    ${PRICES["credit-report"]} tinybar (0.0001 HBAR)
  GET /factoring-rate/:controller   ${PRICES["factoring-rate"]} tinybar (0.00005 HBAR)

An agent that discovers this service: node x402/buyer.js <controller> report
`);
});

app.get("/health", (_req, res) => res.json({ ok: true, network: NETWORK, facilitator: FACILITATOR_URL }));

// ---------------------------------------------------------------------------
// GET /credit-report/:controller — the AI credit analyst, pay-per-call.
// ---------------------------------------------------------------------------
app.get("/credit-report/:controller", async (req, res) => {
  const gate = await gatePayment(req, PRICES["credit-report"]);
  if (gate.status !== 200) {
    res.status(gate.status).json(gate.body);
    return;
  }
  try {
    const controller = await resolveController(req.params.controller);
    const { agent, recommendation, narrative } = await analyzeAgent(controller);
    const payload = {
      service: "credence/credit-report",
      controller,
      ensName: agent.ensName,
      score: Number(agent.score),
      tier: scoreTier(Number(agent.score)),
      humanBacked: agent.humanBacked,
      frozen: agent.frozen,
      spendLimitWei: agent.spendLimitWei,
      totalTx: agent.totalTx,
      defaultTx: agent.defaultTx,
      recommendation: {
        decision: recommendation.decision,
        recommendedLimitWei: recommendation.recommendedLimitWei,
        cleanRate: Number(recommendation.cleanRate.toFixed(4)),
        evidence: recommendation.evidence,
      },
      narrative: narrative || null,
      payment: {
        facilitator: FACILITATOR_URL,
        transactionId: gate.settle.transactionId,
        amountTinybar: PRICES["credit-report"],
        note: "Settled on Hedera testnet via Blocky402. Confirm SUCCESS on HashScan/Mirror.",
      },
    };
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// GET /factoring-rate/:controller — the credit-score pricing oracle, per call.
// ---------------------------------------------------------------------------
app.get("/factoring-rate/:controller", async (req, res) => {
  const gate = await gatePayment(req, PRICES["factoring-rate"]);
  if (gate.status !== 200) {
    res.status(gate.status).json(gate.body);
    return;
  }
  try {
    const controller = await resolveController(req.params.controller);
    const { agent } = await analyzeAgent(controller);
    const score = Number(agent.score);
    const discountRate = agent.frozen ? null : discountRateForScore(score);
    const eligible = !agent.frozen && discountRate !== null;
    const payload = {
      service: "credence/factoring-rate",
      controller,
      ensName: agent.ensName,
      score,
      eligible,
      discountRate: eligible ? discountRate : null,
      discountPercent: eligible ? discountRate * 100 : null,
      oracle: "CreditBureau -> The Graph -> ATS pricing curve (1% Prime .. 15% New)",
      payment: {
        facilitator: FACILITATOR_URL,
        transactionId: gate.settle.transactionId,
        amountTinybar: PRICES["factoring-rate"],
        note: "Settled on Hedera testnet via Blocky402. Confirm SUCCESS on HashScan/Mirror.",
      },
    };
    res.status(200).json(payload);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

const port = Number(process.env.X402_PORT || process.env.PORT || 4030);
if (process.env.X402_SERVE !== "false") {
  app.listen(port, () =>
    console.log(
      `Credence x402 service on :${port} — HBAR per call, settled via ${FACILITATOR_URL}` +
        (PAY_TO ? `, payouts to ${PAY_TO}` : " (set X402_PAY_TO / HEDERA_OPERATOR_ID)"),
    ),
  );
}

export default app;