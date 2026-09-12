# World Selfie Check — Feedback Document

*Scratch-track submission artifact for the **Selfie Check** prize at
ETHOnline 2026 (World).*

Project: **Credence** — on-chain credit infrastructure for autonomous agents
(ENSv2 identity + World Selfie Check human-in-the-loop credential + The Graph
score + Hedera receivables). Built from scratch for this event.

**The one-sentence pitch:** Credence uses World **Selfie Check** as its
abuse-prevention / continuity / eligibility credential — a low-friction
medium-assurance proof that a *live, real person* is behind an agent's wallet,
recorded with its own provenance instead of an Orb-based uniqueness claim.

This document captures our hands-on experience with the Selfie Check (Beta)
integration: docs, the Developer Portal, the Sandbox flow, and what was
confusing, missing, or hard to test. We wrote it from an actually-integrated
codebase (`backend/integrations/world/selfie-check.js`, `backend/server.js` routes
`/api/world/selfie/sign` + `/api/world/selfie/verify`, and the "Verify World"
frontend page).

---

## 1. Selfie Check docs & integration flow

**Docs we used (all current at time of writing):**

- Credential overview — `docs.world.org/world-id/credentials/11`
  ("Selfie Check (Beta) — a medium-assurance biometric credential using the
  device camera for liveness and facial similarity")
- IDKit integrate guide — `docs.world.org/world-id/idkit/integrate`
- JS SDK reference — `docs.world.org/world-id/idkit/javascript`
- Credentials/presets — `docs.world.org/world-id/idkit/credentials`
  (`selfieCheckLegacy` preset)
- Sandbox testing — `docs.world.org/world-id/sandbox/testing-selfie-check`
- Verify API — `docs.world.org/api-reference/developer-portal/verify`
  (`POST /api/v4/verify/{rp_id}`)

**The flow we built (World ID 4.0 IDKit):**

1. **Server-side RP signing.** `signRequest({ signingKeyHex, action })` from
   `@worldcoin/idkit-core/signing` runs in `backend/server.js`
   (`POST /api/world/selfie/sign`); the signing key never leaves the server.
   The action is scoped per agent controller
   (`credence-selfie-<controller>`), which gives us **continuity** (the same
   action-scoped nullifier in the 90-day window) and **abuse prevention** (a
   registered agent can only ever be backed by one selfie-checked person, and
   minting more agents still requires a fresh liveness camera check each time).
2. **Frontend request.** `IDKit.request({ app_id, action, rp_context,
   allow_legacy_proofs, environment }).preset(selfieCheckLegacy({ signal }))`
   from `@worldcoin/idkit-core`. `signal` = the agent controller address.
   Outside the World App, `connectorURI` is rendered as a QR code we display
   in the dashboard (desktop flow); we show the deep link as a fallback.
3. **Polling.** `request.pollUntilCompletion({ pollInterval: 2000, timeout:
   600000 })` returns a discriminated union — it never throws, which is nice
   but easy to miss: you must check `completion.success` yourself.
4. **Backend verification.** We forward the completed IDKit result **as-is**
   to `POST https://developer.world.org/api/v4/verify/{rp_id}`
   (staging: `https://staging-developer.worldcoin.org/api/v4/verify/`).
   The endpoint needs no API key (`security: []` in the OpenAPI spec) — the
   RP ID in the path is the auth surface.
5. **Making it a credit signal.** After the portal confirms the proof: we
   reject nullifier reuse across different agents, bind the signal hash when
   the proof carries one, record the credential, write
   `world.selfiecheck.*` ENSv2 text records, and flip the on-chain
   `CreditBureau.setHumanBacking` flag (score bonus + full starting credit
   limit). Treating Selfie Check as a **medium-assurance** signal (not a
   uniqueness claim) is deliberately reflected in the UI: it is displayed
   separately from the (also-supported) high-assurance AgentBook signal, so a
   reviewer can tell the credentials apart.

**What "medium assurance" meant for our product decisions**
Selfie Check returns a proof of the completed check, **not** a numeric Sybil
score. We therefore never treat it as "one person = one identity". It buys
what the docs advertise: liveness (not a spoof), abuse resistance (friction on
automated/repeated agent creation), and continuity (same returning human
re-verifies the same agent inside the 90-day window).

---

## 2. Developer Portal — navigation, search, product discovery, debugging

**Navigation notes (first time, no prior World ID 4.0 experience):**

- Everything lives under `developer.world.org` → **Apps**. The World ID
  settings live *on the app* (not under a separate "World ID" org menu item),
  which took a few clicks to find.
- The four values the integration needs — `app_id`, `rp_id`, `signing_key`,
  `WORLD_ID_ENVIRONMENT` — are not shown on one screen. `app_id` is on the
  app's general settings; `rp_id` and `signing_key` appear after clicking the
  **"Enable World ID 4.0"** banner on the app (RP registration). We almost
  started coding with only `app_id` and were surprised the IDKit request
  requires `rp_context` with an RP signature — the "Enable World ID 4.0"
  step is the gateway to that world, and the docs' Step 2 ("Create an app…
  If you're migrating from an old app, complete RP registration") is easy to
  skim past.
- **Search/product discovery:** the docs search ("⌘K") is genuinely good and
  surfaced the Selfie Check pages from "selfie". The doc index at
  `/llms.txt` is well structured for agent consumption. The confusing part is
  *category* discovery: Selfie Check is filed under **Credentials**, a
  sub-slab of World ID, and is easy to miss if you land in the Agents/AgentKit
  docs (which is what our previous floor-planned integration did). The prize
  page's "Links and Resources" was actually our best discovery path.
- **Debugging guidance:** the IDKit `getDebugReport()` was very useful
  (`request.transport` told us whether we were on `bridge` vs `mini_app`
  transport), but `setDebug(true)` / `window.IDKIT_DEBUG` only prints verbose
  console logs — we expected a debug panel. The Developer Portal has no
  request/proof inspector for Selfie Check; you debug via server logs and the
  verify endpoint's JSON `detail` fields.

---

## 3. Sandbox App — states, proof flows, test users, errors, edge cases

We set `WORLD_ID_ENVIRONMENT=staging` so the frontend's IDKit request targets
the staging connector, and used the two supported entry surfaces:

- **Web app** (our dashboard): the desktop flow — start on web, `connectorURI`
  rendered as QR, complete on phone, proof returns to the web session. This is
  the flow we demo.
- **Native/mini-app:** running inside a sandbox World ID app with native
  transport, `connectorURI` may be empty; polling still works via the
  native channel.

**States we exercised / code coverage from the sandbox guide:**

| Entry surface | User state | What we exercised |
|---|---|---|
| Web app | Hot (World ID installed, already enrolled) | straight to face match |
| Web app | Hot (installed, not enrolled) | inline enrollment → match |
| Web app | Cold (no World ID installed) | install → account → DoB → invite code → enroll → Selfie Check |

**Test users & credentials** — the sandbox does **not** have distinct
"test user" fixtures for Selfie Check like some other verification flows; you
use the sandbox World ID app's own registered accounts. There is no "mock
selfie image" upload — the camera flow runs for real inside the sandbox app,
front-camera only. This is fine for a demo but means the check is harder to
automate in CI than we'd like.

**Errors & edge cases observed (mapped to IDKitErrorCodes):**

- `user_rejected` — user cancelled in World App; surfaces as
  `completion.error` (non-throwing).
- `credential_unavailable` / `feature_unavailable` — the credential or the
  Selfie Check feature flag is not enabled for the app. **This is the big
  one**: access-gating is real. Until your `app_...` has the flag flipped by a
  World contact, proofs fail with these codes and nothing in the Developer
  Portal UI tells you the flag is missing.
- `invalid_rp_signature` / `rp_signature_expired` / `timestamp_*` — RP signing
  mismatches (key, clock, TTL). The `sign_request` TTL defaults to 300s;
  if your page sits idle on the QR longer than that, re-sign.
- `nullifier_replayed` — a same-action re-proof inside the flow; our backend
  also rejects cross-agent reuse defensively.
- Connection failures — `bridge` transport dies with `connection_failed` when
  the phone drops; discovery: re-render QR.

**Known limitation we hit (matches the sandbox docs):** selfie check has no
distinct"warm" flow — enrollment happens inline in Hot(which the docs call
out). Also sandbox apps are installed via TestFlight / Private Play links, not
the public stores, so team members need the test track link before the demo.

---

## 4. What was confusing, missing, broken, or hard to test

**Confusing**

- **v3 vs v4 response shapes.** IDKit returns `protocol_version: "3.0"` or
  `"4.0"` with *different* field sets (`signal_hash`, `merkle_root`,
  `proof` array vs string, top-level `nullifier` vs `results[].nullifier`).
  The verify endpoint accepts both, and the docs say "don't remap" — but
  *client-side* code still needs to handle both if it wants to display the
  credential. The `signal_hash` for v4 uniqueness proofs is `0x0` even when a
  signal was supplied, which makes "enforce the signal" surprisingly not
  possible for v4 — we bound the **action** per controller instead, which is
  effective but was not documented as an alternative.
- **`IDKit.request()...preset()` is async.** The examples write
  `await IDKit.request(...).preset(...)`; miss the await and you get a
  confusing error about calling `.preset` on a Promise — a very common
  first stumble.
- **The package ships a WASM module.** `idkit-core` loads
  `idkit_wasm_bg.wasm` via `new URL(..., import.meta.url)`; in Vite this
  "just worked", but if you gate WASM loading or source-map URLs, requests fail
  with cryptic errors *before* any proof flow — nothing in the SDK mentions
  wasm in the integration guide.

**Missing / broken (at review time)**

- The **Selfie Check feature flag is undocumented in the Developer Portal** —
  no toggle, no indicator, no error message on your app config. We only
  inferred the requirement from the marketing FAQ on the credential page.
- No **Developer Portal-side proof inspector / debug log** for Selfie Check
  (`getDebugReport()` is client-side only).
- The **"Returning user" continuity window (90 days)** exists but is not
  surfaced anywhere client-side; if a user's selfie credential lapsed, IDKit
  just shows the enrollment flow again with no reason string.

**Hard to test**

- The real proof requires a phone + camera — not automatable in CI. The
  closest thing to a smoke test is the simulator (`simulator.worldcoin.org`)
  for a *staging* environment, which covers request construction and most
  errors, but the actual camera/liveness/continuity path needs a physical
  device.
- `credential_unavailable` for an access-gated app is produced at proof time
  (in the app), not at request time — so your automated tests pass and the
  *first human* test fails if the flag wasn't enabled.
- Sandbox cold/semi-cold funnels take 5–10 minutes of install + onboarding
  steps; the sandbox guide's coverage table was accurate, but budget demo
  time accordingly (use a **hot**, already-enrolled account for demos).

---

## What we'd tell the World team

The credential itself is refreshingly low-friction and very demo-able (camera
liveness beats boring for judges). The three things we'd raise: (1) surface
the Selfie Check feature-flag state in the Developer Portal instead of at
proof time; (2) document the v3/v4 `signal_hash` behavior and offer action-
scoping as a first-party "bound the credential to X" pattern; (3) add a
debug/verification log to the Developer Portal so relying parties can see
verification outcomes server-side.

*Written during ETHOnline 2026 by the Credence team — scratch build, Selfie
Check track.*