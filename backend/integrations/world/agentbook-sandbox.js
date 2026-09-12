/**
 * agentbook-sandbox.js — World-ID-Sandbox AgentBook for Credence.
 *
 * Credence is a SANDBOX-ONLY World ID integration (WORLD_ID_ENVIRONMENT=
 * staging) — we never touch production World ID identities, the production
 * World Chain AgentBook contract (0xA23aB271…) or the production Developer
 * Portal. See:
 *
 *   https://docs.world.org/agents/agent-kit/integrate#step-2-register-the-agent-in-agentbook
 *   https://docs.world.org/world-id/sandbox/testing-selfie-check
 *
 * This module is the AgentBook ground truth in sandbox mode: a small
 * persistent registry that mirrors the canonical AgentBook's
 * `lookupHuman(address) -> humanId` surface, so the ENTIRE identity-mint flow
 * (register the agent address FIRST → humanBacked → ENS mint) can run
 * end-to-end without any production World Chain call.
 *
 * Every result is clearly labeled `mock: true, environment: "sandbox"` so a
 * sandbox credential can never be mistaken for a real World Chain
 * registration. The module FAILS CLOSED whenever the environment is set to
 * production without an explicit WORLD_ALLOW_PRODUCTION=1 escape hatch.
 */

const { ethers } = require("ethers");
const fs = require("node:fs");
const path = require("node:path");

/** File-backed store so sandbox registrations survive backend restarts
 *  during the demo (gitignored — this is throwaway sandbox state). */
const STORE_FILE = path.join(__dirname, ".agentbook-sandbox.json");

const registry = loadStore();

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    }
  } catch (error) {
    console.warn("[agentbook-sandbox] could not read sandbox store (starting empty):", error.message);
  }
  return {};
}

function saveStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(registry, null, 2));
  } catch (error) {
    console.warn("[agentbook-sandbox] could not persist sandbox store:", error.message);
  }
}

/**
 * Sandbox mode is the project default: WORLD_ID_ENVIRONMENT is staging by
 * default (matching selfie-check.js), and WORLD_ID_MOCK=1 also forces it.
 * Production is only ever reachable with BOTH WORLD_ID_ENVIRONMENT=production
 * AND WORLD_ALLOW_PRODUCTION=1 — the fail-closed guard for "never use
 * production World ID".
 */
function isAgentBookSandbox() {
  const env = (process.env.WORLD_ID_ENVIRONMENT || "staging").toLowerCase();
  return process.env.WORLD_ID_MOCK === "1" || env === "staging" || env === "sandbox" || env === "demo";
}

function productionAllowed() {
  return (
    (process.env.WORLD_ID_ENVIRONMENT || "").toLowerCase() === "production" &&
    process.env.WORLD_ALLOW_PRODUCTION === "1"
  );
}

/** Fail closed: refuse production World ID unless explicitly allowed. */
function assertSandboxOnly() {
  if (isAgentBookSandbox()) return;
  if (productionAllowed()) return;
  throw new Error(
    "This project runs on the World ID SANDBOX only — WORLD_ID_ENVIRONMENT=staging is the default and " +
      "production World Chain AgentBook is disabled. If you really need production, set " +
      "WORLD_ID_ENVIRONMENT=production AND WORLD_ALLOW_PRODUCTION=1 (and never demo with it)."
  );
}

/** Deterministic anonymous human id for a sandbox wallet. */
function mockHumanIdFor(address) {
  return ethers.keccak256(ethers.toUtf8Bytes(`credence-sandbox-${String(address).toLowerCase()}`)).slice(0, 26);
}

/**
 * Register an agent controller in the sandbox AgentBook (idempotent).
 * Mirrors the canonical AgentBook's `register` step
 * (docs.world.org/agents/agent-kit/integrate#step-2) but writes to the local
 * sandbox registry instead of World Chain.
 *
 * @param {string} address agent controller/operator wallet
 * @returns {Promise<{registered: boolean, humanId: string, address: string, mock: true, environment: "sandbox", alreadyRegistered: boolean, registry: string, message: string}>}
 */
async function sandboxRegister(address) {
  assertSandboxOnly();
  const normalized = ethers.getAddress(address);
  const key = normalized.toLowerCase();
  const existing = registry[key];
  const record = existing && existing.humanId ? existing : { humanId: mockHumanIdFor(normalized) };
  registry[key] = { ...record, registeredAt: existing?.registeredAt || new Date().toISOString() };
  saveStore();
  return {
    registered: true,
    humanId: record.humanId,
    address: normalized,
    mock: true,
    environment: "sandbox",
    alreadyRegistered: Boolean(existing && existing.humanId),
    registry: "credence-sandbox-agentbook",
    message: `Sandbox AgentBook registration — mock human ${record.humanId} backs ${normalized} (no production World Chain call).`,
  };
}

/**
 * Look up an agent controller in the sandbox AgentBook (the sandbox version
 * of `createAgentBookVerifier().lookupHuman`).
 * @returns {Promise<{registered: boolean, humanId: string|null, address: string, mock: true, environment: "sandbox", registry: string} | null>}
 */
async function sandboxLookup(address) {
  assertSandboxOnly();
  const normalized = ethers.getAddress(address);
  const key = normalized.toLowerCase();
  const record = registry[key];
  if (!record || !record.humanId) return null;
  return {
    registered: true,
    humanId: record.humanId,
    address: normalized,
    mock: true,
    environment: "sandbox",
    registry: "credence-sandbox-agentbook",
  };
}

/** Sandbox flavor of the full status record returned by checkAgentBookStatus. */
async function sandboxStatus(address) {
  assertSandboxOnly();
  const normalized = ethers.getAddress(address);
  const lookup = await sandboxLookup(normalized);
  return {
    registered: Boolean(lookup),
    humanId: lookup ? lookup.humanId : null,
    address: normalized,
    mock: true,
    environment: "sandbox",
    registry: "credence-sandbox-agentbook",
  };
}

module.exports = {
  STORE_FILE,
  isAgentBookSandbox,
  productionAllowed,
  assertSandboxOnly,
  sandboxRegister,
  sandboxLookup,
  sandboxStatus,
};