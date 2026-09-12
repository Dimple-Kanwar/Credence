/**
 * selfie-check.js — World Selfie Check credential leg for Credence.
 *
 * Selfie Check (Beta) is World's medium-assurance biometric credential: the
 * user's device camera performs liveness + facial-similarity checks (no Orb,
 * no passport, no uniqueness guarantee). This module turns a verified Selfie
 * Check proof into a **credit signal** for the bureau:
 *
 *   - abuse prevention: a fresh liveness proof is required to flip
 *     `humanBacked` on-chain / in ENS, so a script cannot mint fake
 *     human-backed agent identities without a real, live person completing the
 *     camera flow each time;
 *   - continuity: the nullifier is action-scoped to one controller
 *     (`credence-selfie-<controller>`), so a returning human re-verifying the
 *     same agent yields the same nullifier (90-day inactivity window applies);
 *   - eligibility/risk: Selfie Check is lower-assurance than Proof of Human,
 *     so it is recorded with its own provenance (`world.selfiecheck.*` ENS
 *     records + backend record) while still feeding the on-chain `humanBacked`
 *     flag for the score bonus.
 *
 * Flow (World ID 4.0 IDKit):
 *   1. Backend signs the request: signRequest({ signingKeyHex, action }) —
 *      the RP signing key never leaves the server.
 *   2. Frontend builds IDKit.request({ ... rp_context, environment })
 *      .preset(selfieCheckLegacy({ signal })) and shows the connector URI
 *      (QR / deep link).
 *   3. World App returns an IDKitResult (protocol 3.0 legacy or 4.0).
 *   4. Backend forwards it as-is to POST /api/v4/verify/{rp_id} on the
 *      Developer Portal, checks the nullifier for replay, binds the signal,
 *      records the credential and pushes the on-chain flag.
 *
 * Docs: https://docs.world.org/world-id/credentials/11
 *       https://docs.world.org/world-id/idkit/integrate
 * Sandbox: https://docs.world.org/world-id/sandbox/testing-selfie-check
 *
 * NOTE Selfie Check (Beta) is access-gated — the feature flag must be enabled
 * for your Developer Portal app (via your World point of contact) before
 * proofs succeed.
 */

const { ethers } = require("ethers");
const { signRequest } = require("@worldcoin/idkit-core/signing");
const { hashSignal } = require("@worldcoin/idkit-core/hashing");
const { dnsEncode } = require("./agent-provision.js");
require("dotenv").config();

const WORLD_RP_SIGNING_KEY = process.env.WORLD_RP_SIGNING_KEY || "";
const WORLD_ID_APP_ID = process.env.WORLD_ID_APP_ID || process.env.WORLD_APP_ID || "";
const WORLD_ID_RP_ID = process.env.WORLD_ID_RP_ID || "";
const WORLD_ID_ENVIRONMENT = process.env.WORLD_ID_ENVIRONMENT || "staging"; // sandbox by default — NEVER production for this project
const WORLD_ID_VERIFY_URL = process.env.WORLD_ID_VERIFY_URL || "";
const SIGN_TTL_SECONDS = Number(process.env.WORLD_SIGN_TTL_SECONDS || 300);
// Opt-in demo mode (WORLD_ID_MOCK=1 or WORLD_ID_ENVIRONMENT=demo): completes
// the full request → QR → verify loop without the access-gated Developer
// Portal call, and records the credential as `environment: demo-mock` so it
// can never be mistaken for a real Selfie Check proof. Use it to demo until
// the Selfie Check feature flag is enabled for your app.
const MOCK_MODE = process.env.WORLD_ID_MOCK === "1" || WORLD_ID_ENVIRONMENT === "demo";

// Demo-scoped credential store (in-memory). In production, back this with a
// DB: a selfie credential per controller, plus a used-nullifier table with a
// UNIQUE(nullifier) constraint across the whole app to stop cross-agent reuse.
const selfieChecks = new Map(); // controller(lower) -> record
const usedNullifiers = new Map(); // nullifier -> action it was minted for

const CREDIT_BUREAU_ABI = [
  "function setHumanBacking(address controller, bool humanBacked) external",
  "function resolverOf(address controller) external view returns (address)",
];

const SELFIE_ENS_KEYS = {
  verified: "world.selfiecheck.verified",
  nullifier: "world.selfiecheck.nullifier",
  at: "world.selfiecheck.timestamp",
  action: "world.selfiecheck.action",
  environment: "world.selfiecheck.environment",
};

/** Action names are scoped per controller so the nullifier provides continuity
 *  and each agent can only ever be backed by one human. */
function expectedActionFor(controller) {
  return `credence-selfie-${String(controller).trim().toLowerCase()}`;
}

function verifyBaseUrl() {
  if (WORLD_ID_VERIFY_URL) return WORLD_ID_VERIFY_URL;
  return WORLD_ID_ENVIRONMENT === "production"
    ? "https://developer.world.org/api/v4/verify/"
    : "https://staging-developer.worldcoin.org/api/v4/verify/";
}

function isSelfieConfigured() {
  return Boolean(WORLD_RP_SIGNING_KEY && WORLD_ID_APP_ID && WORLD_ID_RP_ID);
}

/**
 * Server-side request signing (Step 1 of the IDKit flow). Returns everything
 * the frontend needs to build + display the request; keys stay server-side.
 * @param {string} controller the raw signal string (agent wallet address or
 *   ENS name) the proof will be bound to.
 * @returns {{app_id, rp_id, action, sig, nonce, created_at, expires_at, environment, connector_hint}}
 */
async function signSelfieRequest(controller) {
  const input = String(controller || "").trim();
  if (!input) throw new Error("A controller address (or ENS name) is required.");
  if (!isSelfieConfigured()) {
    throw new Error(
      "Selfie Check is not configured. Set WORLD_RP_SIGNING_KEY, WORLD_ID_APP_ID and WORLD_ID_RP_ID in backend .env."
    );
  }
  const action = expectedActionFor(input);
  if (WORLD_ID_ENVIRONMENT === "production") {
    throw new Error(
      "This project runs on the World ID Sandbox only — set WORLD_ID_ENVIRONMENT=staging " +
        "(and WORLD_ID_APP_ID=app_staging_...) in backend .env. Production identities are disabled."
    );
  }
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: WORLD_RP_SIGNING_KEY,
    action,
    ttl: SIGN_TTL_SECONDS,
  });
  return {
    app_id: WORLD_ID_APP_ID,
    rp_id: WORLD_ID_RP_ID,
    action,
    sig,
    nonce,
    created_at: createdAt,
    expires_at: expiresAt,
    environment: WORLD_ID_ENVIRONMENT,
    mock: MOCK_MODE,
    connector_hint: MOCK_MODE
      ? "DEMO MODE — scan any QR; verification is simulated and recorded as demo-mock"
      : WORLD_ID_ENVIRONMENT === "production"
        ? "Complete the check in the World App"
        : "Sandbox — complete the check in the World ID sandbox app (simulator.worldcoin.org for the web/simulator flow)",
  };
}

/**
 * Verify the IDKit result with the Developer Portal, enforce replay/signal
 * rules, record the credential. Optionally pushes the on-chain flag and ENS
 * records (needs server env vars — never browser keys).
 *
 * @param {object} args
 * @param {string} args.controller raw signal string used at signing time
 * @param {string} [args.rp_id]
 * @param {object} args.idkitResponse the IDKitCompletionResult.result payload
 * @param {boolean} [args.pushOnChain] write ENS records + setHumanBacking
 * @param {string} [args.ensName] full ENS name for the ENS records write
 * @returns {Promise<{verified, controller, nullifier, action, environment, verifiedAt, duplicate, txHash?, records?}>}
 */
async function verifySelfieProof({ controller, rp_id, idkitResponse, pushOnChain, ensName }) {
  const signal = String(controller || "").trim();
  if (!signal) throw new Error("A controller address (or ENS name) is required.");
  if (!idkitResponse || typeof idkitResponse !== "object" || !Array.isArray(idkitResponse.responses) || idkitResponse.responses.length === 0) {
    throw new Error("Invalid IDKit response — expected a completed proof payload.");
  }
  const targetRp = rp_id || WORLD_ID_RP_ID;
  if (!targetRp) throw new Error("No rp_id to verify against — pass rp_id or set WORLD_ID_RP_ID.");

  // The action the proof was minted for must match this controller.
  const expectedAction = expectedActionFor(signal);
  const proofAction = idkitResponse.action;
  if (proofAction && String(proofAction).toLowerCase() !== expectedAction.toLowerCase()) {
    throw new Error(`Action mismatch: proof was minted for "${proofAction}" but this controller maps to "${expectedAction}".`);
  }

  const url = `${verifyBaseUrl()}${encodeURIComponent(targetRp)}`;
  let payload;
  let portalOk;
  let httpStatus = 0;
  if (MOCK_MODE) {
    // Simulated verification: accept the completed IDKit payload shape and
    // derive a deterministic demo nullifier from the action. Never record the
    // result as a real credential — environment is forced to demo-mock.
    payload = { success: true, action: proofAction, environment: "demo-mock", created_at: new Date().toISOString() };
    portalOk = true;
  } else {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(idkitResponse),
    });
    httpStatus = response.status;
    payload = await response.json().catch(() => ({}));
    portalOk = response.ok && Boolean(payload.success);
  }
  if (!portalOk) {
    const detail = payload.detail || payload.code || `HTTP ${httpStatus || "unknown"}`;
    throw new Error(`World ID verification failed: ${detail}`);
  }

  const environment = MOCK_MODE ? "demo-mock" : payload.environment || idkitResponse.environment || WORLD_ID_ENVIRONMENT;
  const nullifier = MOCK_MODE
    ? ethers.keccak256(ethers.toUtf8Bytes(`${expectedAction}|mock-selfie`))
    : payload.nullifier || payload.results?.[0]?.nullifier || idkitResponse.responses?.[0]?.nullifier;
  if (!nullifier) throw new Error("World ID returned no nullifier for the Selfie Check proof.");

  // --- replay / cross-agent reuse prevention ------------------------------
  const prior = usedNullifiers.get(nullifier);
  if (prior && prior !== expectedAction) {
    throw new Error("This Selfie Check proof was already used for a different agent.");
  }

  // --- signal binding (only when the proof actually carries a signal hash) --
  const first = idkitResponse.responses[0];
  const zeroHash = "0x" + "0".repeat(64);
  if (first.signal_hash && first.signal_hash !== "0x0" && first.signal_hash.toLowerCase() !== zeroHash) {
    const expected = hashSignal(signal);
    if (first.signal_hash.toLowerCase() !== expected.toLowerCase()) {
      throw new Error("Signal mismatch: the proof was minted for a different controller.");
    }
  }

  usedNullifiers.set(nullifier, expectedAction);
  const duplicate = prior === expectedAction;
  const record = {
    verified: true,
    controller: signal,
    nullifier,
    action: expectedAction,
    environment,
    verifiedAt: payload.created_at || new Date().toISOString(),
    duplicate,
    mock: MOCK_MODE,
  };
  selfieChecks.set(signal.toLowerCase(), record);

  // --- durable writes: ENS records + on-chain humanBacked flag ------------
  if (record.verified) {
    const durable = await persistSelfieCredential(signal, record, { ensName });
    record.txHash = durable.txHash || null;
    record.records = durable.records || [];
  }

  return record;
}

/** Read the recorded Selfie Check credential for a controller (safe shape for
 *  the frontend — full nullifier is included; treat as public-ish metadata). */
function getSelfieCheckStatus(controller) {
  const record = selfieChecks.get(String(controller || "").toLowerCase());
  if (!record) return { verified: false };
  return {
    verified: true,
    verifiedAt: record.verifiedAt,
    environment: record.environment,
    action: record.action,
    mock: Boolean(record.mock),
    nullifier: record.nullifier,
    nullifierShort: `${record.nullifier.slice(0, 10)}…${record.nullifier.slice(-6)}`,
  };
}

/**
 * Push the verified credential into the agent's identity: write
 * world.selfiecheck.* ENS text records (controller wallet / server key) and
 * flip CreditBureau.setHumanBacking so the score bonus applies. Both are
 * best-effort — the in-memory record above is the source of truth for the
 * demo, and failures are surfaced as warnings, not hard errors.
 */
async function persistSelfieCredential(controllerSignal, record, { ensName } = {}) {
  const key = process.env.CONTROLLER_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  // staticNetwork skips the RPC's network-detection retry loop so a flaky
  // Sepolia node can't stall the verify response — the push is best-effort.
  const provider = new ethers.JsonRpcProvider(
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
    11155111,
    { staticNetwork: true }
  );
  const controller = ethers.isAddress(controllerSignal)
    ? ethers.getAddress(controllerSignal)
    : null;
  const out = { txHash: null, records: [] };
  if (!key) return out;

  const bureau = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS || ethers.ZeroAddress, CREDIT_BUREAU_ABI, provider);

  // On-chain flag (needs the controller's address + an authorized reporter key).
  if (controller && process.env.CREDIT_BUREAU_ADDRESS) {
    try {
      const wallet = new ethers.Wallet(key, provider);
      const signed = new ethers.Contract(process.env.CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, wallet);
      const tx = await signed.setHumanBacking(controller, true);
      const receipt = await tx.wait();
      out.txHash = receipt.hash;
    } catch (error) {
      console.warn("[selfie-check] setHumanBacking failed (on-chain push skipped):", error.message);
    }
  }

  // ENS identity records (best-effort).
  if (controller && ensName) {
    try {
      const resolverAddress = await bureau.resolverOf(controller);
      if (resolverAddress && resolverAddress !== ethers.ZeroAddress) {
        const wallet = new ethers.Wallet(key, provider);
        const resolver = new ethers.Contract(
          resolverAddress,
          ["function setText(bytes name, string key, string value) external"],
          wallet
        );
        const dnsName = dnsEncode(ensName);
        const texts = {
          [SELFIE_ENS_KEYS.verified]: "true",
          [SELFIE_ENS_KEYS.nullifier]: record.nullifier,
          [SELFIE_ENS_KEYS.at]: record.verifiedAt,
          [SELFIE_ENS_KEYS.action]: record.action,
          [SELFIE_ENS_KEYS.environment]: record.environment,
        };
        for (const [keyName, value] of Object.entries(texts)) {
          try {
            const tx = await resolver.setText(dnsName, keyName, value);
            await tx.wait();
            out.records.push(`${keyName}=${value}`);
          } catch (writeErr) {
            console.warn(`[selfie-check] Could not write ENS record "${keyName}":`, writeErr.message);
          }
        }
      }
    } catch (error) {
      console.warn("[selfie-check] ENS records write skipped:", error.message);
    }
  }
  return out;
}

module.exports = {
  SELFIE_ENS_KEYS,
  expectedActionFor,
  isSelfieConfigured,
  signSelfieRequest,
  verifySelfieProof,
  getSelfieCheckStatus,
};