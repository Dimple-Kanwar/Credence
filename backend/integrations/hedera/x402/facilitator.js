/**
 * facilitator.js — Blocky402 hosted facilitator helpers (Hedera testnet).
 *
 * Blocky402 is the hosted x402 facilitator for Hedera used by the ETHOnline
 * track: "AI & Agentic Payments on Hedera". The facilitator holds the fee
 * payer, verifies a buyer's signed payment payload, and settles the HBAR
 * transfer on testnet. The resource server (our x402 service) never holds
 * a private key — it only asks the facilitator to verify + settle.
 *
 * Facilitator JSON responses are CLAIMS, not independent ledger evidence.
 * `mirrorCryptoTransferSuccess` cross-checks the Mirror Node when a settle
 * comes back DUPLICATE_TRANSACTION, so a service can still authorise the
 * delivery when the ledger shows the transfer landed.
 *
 * Endpoints (testnet): GET /supported, POST /verify, POST /settle
 */

/** Pull a Hedera transaction id out of facilitator fields / error text. */
export function extractHederaTxId(...candidates) {
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const m = c.match(/0\.0\.\d+[@-]\d+[.\-]\d+/);
    if (m) return m[0];
  }
  return null;
}

/** Mirror Node path form: 0.0.x-seconds-nanos */
export function toMirrorTxId(txId) {
  return String(txId)
    .replace("@", "-")
    .replace(/\.(\d+)$/, "-$1");
}

/**
 * Ask the facilitator which fee payer it advertises for hedera:testnet.
 * The resource server embeds it in the 402 `accepts[0].extra.feePayer`,
 * which is exactly the account the buyer's signed transfer must pay.
 */
export async function fetchFeePayer(facilitatorUrl) {
  const res = await fetch(`${facilitatorUrl}/supported`);
  if (!res.ok) throw new Error(`Blocky402 GET /supported HTTP ${res.status}`);
  const data = await res.json();
  const kind = (data.kinds || []).find((k) => k.network === "hedera:testnet");
  const feePayer = kind?.extra?.feePayer || data.signers?.["hedera:*"]?.[0];
  if (!feePayer) throw new Error("Blocky402 did not advertise hedera:testnet feePayer");
  return feePayer;
}

/**
 * SETTLE-ONCE: only the resource server calls /settle. The buyer only signs
 * the transfer and sends X-PAYMENT; it must never settle too (double-settles
 * produce DUPLICATE_TRANSACTION).
 *
 * If a prior settle already landed, the DUPLICATE error + a Mirror
 * CRYPTOTRANSFER SUCCESS still authorise the delivery — payment is ledger
 * evidence, delivery is the resource server's decision.
 */
export async function verifyAndSettle(facilitatorUrl, paymentPayload, paymentRequirements) {
  const body = JSON.stringify({
    x402Version: 2,
    paymentPayload,
    paymentRequirements,
  });
  const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const verification = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok || !verification.isValid) {
    return {
      ok: false,
      stage: "verify",
      claim: verification,
      error:
        verification.invalidMessage ||
        verification.invalidReason ||
        `verify HTTP ${verifyRes.status}`,
    };
  }

  const settleRes = await fetch(`${facilitatorUrl}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const settlement = await settleRes.json().catch(() => ({}));
  if (!settleRes.ok || !settlement.success) {
    const err = settlement.errorMessage || settlement.errorReason || `settle HTTP ${settleRes.status}`;
    const dup =
      typeof err === "string" &&
      (err.includes("DUPLICATE_TRANSACTION") || err.includes("DUPLICATE"));
    const txGuess = extractHederaTxId(settlement.transaction, settlement.transactionId, err);
    if (dup && txGuess) {
      const mirrorOk = await mirrorCryptoTransferSuccess(txGuess);
      if (mirrorOk.ok) {
        return {
          ok: true,
          claim: settlement,
          transactionId: mirrorOk.transactionId,
          note: "settle claim failed DUPLICATE; Mirror shows CRYPTOTRANSFER SUCCESS",
        };
      }
    }
    return { ok: false, stage: "settle", claim: settlement, error: err };
  }

  return {
    ok: true,
    claim: settlement,
    transactionId: settlement.transaction || settlement.transactionId || null,
  };
}

/** Mirror Node check: does this tx id show a SUCCESSful CRYPTOTRANSFER? */
export async function mirrorCryptoTransferSuccess(txId) {
  const dash = toMirrorTxId(txId);
  try {
    const res = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(dash)}`,
    );
    if (!res.ok) return { ok: false };
    const data = await res.json();
    const txs = data.transactions || [];
    const hit = txs.find(
      (t) => t.result === "SUCCESS" && String(t.name || "").includes("CRYPTOTRANSFER"),
    );
    if (!hit) return { ok: false };
    return { ok: true, transactionId: hit.transaction_id || dash };
  } catch {
    return { ok: false };
  }
}