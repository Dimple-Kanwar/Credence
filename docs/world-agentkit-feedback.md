# World AgentKit Feedback Document

*Required submission artifact for the **AgentKit Continuity** prize at ETHOnline 2026.*

Project: **Credence** — onchain credit infrastructure for autonomous agents
(ENSv2 identity + World human-backing + The Graph score + Hedera receivables).

This document captures our hands-on experience integrating AgentKit
(https://docs.world.org/agents/agent-kit/integrate) into Credence, the
Developer Portal / Sandbox flow we used, and what was confusing, missing, or
hard to test. We integrated the current API surface exactly as documented:

- `createAgentBookVerifier().lookupHuman(address)` — resolve an agent wallet
  to its anonymous human ID against the canonical AgentBook on World Chain
  (`0xA23aB2712eA7BBa896930544C7d6636a96b944dA`).
- `parseAgentkitHeader` → `validateAgentkitMessage` → `verifyAgentkitSignature`
  → `lookupHuman` — the "server-side gate" flow.
- `createAgentkitClient({ signer })` + `declareAgentkitExtension(...)` —
  the agent-side signing flow.
- `npx @worldcoin/agentkit-cli register/status <address>` — AgentBook
  registration / status CLI for testing.

## How we used AgentKit (in a sentence)

Credence issues credit lines to AI agents; the single most important
anti-fraud signal is "is a *unique real human* behind this agent?" We use
AgentKit as the ground-truth oracle for that: `humanBacked` on the on-chain
`CreditBureau` profile is now **derived from a live AgentBook lookup of the
agent's controller wallet** instead of a checkbox, and the resolved human ID
is written back into the agent's own ENSv2 resolver text records
(`world.agentbook.human-id`, `world.agentbook.backed`, `world.agentbook.lookup`,
`world.agentbook.timestamp`) as part of minting the agent's ENS identity.

We also expose an HTTP gate (`/api/world/gate`) that takes an `agentkit`
header, cryptographically verifies it, and resolves the signer to its human ID
through AgentBook — so a consumer of the credit data (e.g. the MCP server or a
factoring UI) can distinguish a **bot** from a **human-backed agent** in one
call, and so a human-backed agent can prove its backing with a signed request
header (`backend/integrations/world/agent-client.js`).

## Developer Portal & Sandbox App experience

- **Discovery**: "AgentKit" is reachable under **Agents → AgentKit** in the
  docs sidebar and is also linked from the World prize page. The docs index
  (`/llms.txt`) exists and helps navigation tools, which was nice.
- **Sandbox App**: we created an app in the Developer Portal
  (`app_...`), set `WORLD_APP_ID` in `.env`, and used the World ID Sandbox App
  to test the proof flow. The sandbox lets you simulate the verification flow
  without a physical Orb — this was essential for a remote hackathon since the
  hosted relay + World App proof flow is otherwise interactive-only.
- **AgentBook**: AgentBook registration requires the wallet being registered to
  complete the World App verification flow (deep link / QR). This is by design
  (a human must prove themselves), but it means agent registration cannot be
  done fully headlessly from a CI box; the Sandbox App is the intended
  out-of-band path.

## Integration flow notes (what we built, step by step)

1. `npx --yes @worldcoin/agentkit-cli status <agentController>` (or the SDK's
   `createAgentBookVerifier().lookupHuman`) — read-only check.
2. If unregistered, the agent's human completes the World App proof flow
   (deep link `https://worldcoin.org/verify?app_id=…&signal=<address>`, or
   `agentkit-cli register <address>` in a terminal that can open the World App).
3. `backend/integrations/ens/register-single-agent.js` queries AgentBook *during* ENS
   identity minting and derives `humanBacked` from the real result — no
   hardcoded `true`.
4. The resolved `humanId` is written into the agent's own ENSv2 Permissioned
   Resolver text records (the controller wallet holds ALL_ROLES on its own
   resolver, so it can write any record itself — no extra EAC grant).
5. `backend/integrations/world/verify-agent.js` pushes `CreditBureau.setHumanBacking`
   on Sepolia so the score bonus and Sybil-resistance premium apply, and the
   subgraph / dashboard / MCP report all reflect it.
6. `/api/world/gate` + `/api/report` (with an `agentkitHeader`) verify the
   SIWE extension and resolve the human on World Chain before returning data.

## What was confusing or surprising

- **x402 is the default mental model, but lookup/verification helpers are what
  most non-payment dapps need.** The quickstart leads with Hono + `@x402/hono`
  payment middleware. For a credit bureau we did **not** need to charge agents
  per request — we needed the *identity* surface. It took reading the SDK
  Reference to discover `parseAgentkitHeader` / `validateAgentkitMessage` /
  `verifyAgentkitSignature` / `createAgentBookVerifier` and assemble the
  "manual usage" flow. A short "I just want verification, not payments" section
  in the integrate guide would have saved us an hour.
- **`lookupHuman` returns `null` for unregistered wallets and `0n` maps to
  `null`, but the distinction between "wallet exists but has no human" and
  "RPC error" is collapsed** (the helper catches and returns `null`). We
  default to fail-closed (unregistered ⇒ not human-backed), which is right for
  credit, but a dev might mis-read network errors as "not registered".
- **CLI `register` is interactive (World App proof) and cannot run unattended.**
  The Sandbox App covers this for remote testing, but the docs could state
  earlier that agent registration requires an interactive human step by design.
- **Resource URI binding is strict.** `validateAgentkitMessage(payload,
  resourceUri)` requires the caller's `resourceUri` to match what was signed.
  Our gate had to echo the client-provided `resourceUri` back; when we tried a
  hardcoded host it failed with `uri mismatch`. Once we understood it, the
  binding is obviously a good security property — worth one line in the docs.
- **Chain-agnostic caller, World-Chain-anchored lookup** was intuitive and a
  genuinely nice design: agents live on any chain, humans are resolved from
  World Chain canonical AgentBook.

## Bugs / rough edges we hit

- `@worldcoin/agentkit` depends on `viem`'s worldchain entry; calling
  `createAgentBookVerifier()` without an explicit `rpcUrl` uses the default
  public World Chain RPC, which can be slow/rate-limited from some regions. We
  added an optional `WORLD_CHAIN_RPC_URL` override everywhere we construct the
  verifier. A first-class `rpcUrl` param is present in `createAgentBookVerifier`
  (good), but the global default could be documented as "public, may be
  throttled".
- Node version: the package ships dual CJS/ESM builds and works with both
  `require` and `import` — we used CJS in scripts, ESM types in editor, no
  issues.

## Edge cases handled in the integration

- Unregistered wallet → `humanBacked=false`, score starts lower (no bonus),
  spend limit starts at half — agents are still usable, just priced for Sybil
  risk (documented simplification; say it aloud in the demo).
- Revocation: `agentkit-cli status` re-check on demand; the dashboard exposes a
  live "Verify World" flow that re-runs the AgentBook lookup before re-setting
  `setHumanBacked`.
- Gate semantics: missing header ⇒ caller is treated as a bot for *gated*
  routes, but public reads (Graph endpoints) remain open; a signed header from
  an *unregistered* wallet is denied with an actionable error.

## What we'd love to see next

1. A standalone "verification without payments" section in
   `docs.world.org/agents/agent-kit/integrate` using only SDK Reference
   helpers (parse/validate/verify + AgentBook lookup), in plain Express/Node.
2. Sandbox App-specific docs for AgentBook registration steps (exact flow:
   create app → configure App ID → register test wallet → observe AgentBook
   entry) since remote hackathon testing depends on it.
3. Typo-free round-trip: surface whether `lookupHuman` returned "registered but
   human = 0" vs "RPC error" (e.g. re-throw or structured error field).

## Verification commands (reproducible)

```bash
# read-only AgentBook lookup for any wallet
node backend/integrations/world/agent-provision.js status 0x<address>
# ENS mint with World-derived humanBacked (needs Sepolia env)
node backend/integrations/ens/register-single-agent.js trader 0x<controller>
# on-heain push + optional ENS identity records
node backend/integrations/world/verify-agent.js 0x<controller> --ens-name trader.agentcreditbure.us.seth
# bot-vs-human gate (needs running backend)
node backend/integrations/world/agent-client.js gate 0x<controller>
```

---

*Written during ETHOnline 2026 by the Credence team. We used the Sandbox App
for proof-flow testing; production AgentBook registration for real wallets goes
through the World App proof flow as designed.*