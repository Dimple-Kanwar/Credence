# World AgentKit: AgentBook Human Verification in Credence

This is the engineering companion to
[`world-agentkit-feedback.md`](./world-agentkit-feedback.md) (the required
submission feedback doc). It documents **how** Credence integrates the
[@worldcoin/agentkit](https://www.npmjs.com/package/@worldcoin/agentkit) SDK,
the exact AgentBook flow, and every place it is wired in.

Read this before the other files:

- [AgentKit World docs](https://docs.world.org/agents/agent-kit/integrate) —
  the canonical integration guide.
- [World Developer Portal](https://worldcoin.org/agents) — AgentBook,
  Apps, Sandbox App.
- [World Contracts reference](../../../node_modules/@worldcoin/agentkit/dist/README.md)
  — full SDK surface including `createAgentBookVerifier`,
  `parseAgentkitHeader`, `verifyAgentkitSignature`, and `lookupHuman`.

> ⚠ **SANDBOX ONLY — never production World ID.** This project runs on the
> World ID sandbox (`WORLD_ID_ENVIRONMENT=staging`). The AgentBook leg is
> served by [`./agentbook-sandbox.js`](./agentbook-sandbox.js): a labeled,
> file-backed sandbox registry that mirrors AgentBook's `lookupHuman` surface.
> Registration reads/writes never touch the production World Chain AgentBook
> contract, and every credential is tagged `mock: true, environment:
> "sandbox"`. Production World Chain is hard-disabled (`assertSandboxOnly()`)
> unless both `WORLD_ID_ENVIRONMENT=production` and `WORLD_ALLOW_PRODUCTION=1`
> are set. The Selfie Check leg uses the staging Developer Portal
> (staging-developer.worldcoin.org) — see [`selfie-check.js`](./selfie-check.js).

---

## 1. TL;DR

On agent registration we look the agent's controller wallet up in **AgentBook**
(the canonical global registry of AI agents hosted on World Chain). AgentBook
resolves each agent to an **anonymous human ID** (the human who backed the
agent through the World App proof flow). Credence then:

1. writes the resolved `humanBacked` + `humanId` into the agent's own **ENSv2
   identity** (Permissioned Resolver text records) as part of minting; and
2. stores the human backing on-chain via `CreditBureau.setHumanBacking` so the
   **credit score bonus** and **Sybil-resistance premium** in the pricing model
   reflect real human backing.

The result: an agent can *prove* it is backed by a unique human (or that it is
human-free) in every downstream request, via the **World Chain gate** —
without revealing the human's identity.

---

## 2. High-level flow

```
                                     ┌──────────────────────────┐
        ┌────────────────────────────│   World Chain (Sepolia)  │
        │                            │                          │
        │   ┌───────┐                │  ┌──────────────────┐    │
        │   │ World │  proof flow    │  │     AgentBook     │    │
        │   │  App  │───────────────►│  │ (ENS + resolver)  │    │
        │   │       │                │  └────────┬─────────┘    │
        │   └───────┘                │           │              │
        │                            │           │ lookupHuman  │
        │   ┌───────────────┐        │  ┌────────▼─────────┐    │
        │   │ integrate/    │        │  │  World ID Contract│    │
        │   │ world/        │────────┼─►│  (human backing)  │    │
        │   │ agent-client  │        │  └──────────────────┘    │
        │   └───────┬───────┘        └──────────────────────────┘
        │           │ WS_VERIFY_URL + signed World header
        │           ▼
        │   ┌────────────────────┐     ┌──────────────────┐
        │   │  World Chain gate  │────►│  ETHGlobal Node  │
        │   │  /api/world/gate   │     │  Federation      │
        │   └─────────┬──────────┘     └──────────────────┘
        │             ▼
        │   ┌────────────────────────────────────────────┐
        │   │  POST /api/world/gate?verifyAgent=...      │
        │   │  lookups: AgentBook + CreditBureauSync     │
        │   └────────────────────────────────────────────┘
        └────────────────────────────────────────────────┘

Flow:
 1. Agent wants credit. Its controller sends `POST /api/world/gate` with a
    **World-signed header** (the World App "connect" proof, worldchain-scoped).
 2. The backend `verifyAgentkitSignature(header, resourceUri)` → the recovered
    signer (agent's controller wallet).
 3. `createAgentBookVerifier().lookupHuman(signer)` → `humanBacked` +
    `humanId` (or `null` for a purely-bot agent).
 4. The gate enforces the **per-route policy** (see below) and returns the
    resolved human context.
 5. On registration we persist `humanBacked` into the agent's ENSv2 identity
    and into the on-chain `CreditBureau`.
```

---

## 3. Agent identity

For an agent to be credit-addressable we mint **ENSv2 names in the
`wallet.credence.eth` namespace** under an account we control, and the agent's
controller address is the node owner. Example identities (these names are used
all over the demo):

| Agent name (ENSv2)            | Controller wallet (AgentBook)            | Human-backing        |
| ----------------------------- | ---------------------------------------- | -------------------- |
| `vampire.agent.eth`           | `0x...E26b` (unregistered)               | `humanBacked: false` |
| `mining.agent.eth`            | `0x...0669` (registered in AgentBook)    | `humanBacked: true`  |
| `trader.agent.eth`            | `0x...8F4e` (registered in AgentBook)    | `humanBacked: true`  |

The human identity is written into the agent's own ENSv2 Permissioned
Resolver text records as part of minting:

```text
world.agentbook.human-id  <0x9A5b…aBcE>   (anonymous human id, hashed in AgentBook)
world.agentbook.backed    1
world.agentbook.lookup    agentbook.worldcoin.org (chain-anchored lookup)
world.agentbook.timestamp 2026-xx-xxTxx:xx:xx+00:00
```

Why ENS text records? So the human backing is **self-documenting and
portable** — any ENSv2 reader, the gate, or the demo can resolve it without
another RPC call, and it mirrors what AgentBook derives on-chain. Crucially,
the **controller wallet holds ALL_ROLES on its own resolver**, so it can
update these records itself at any time (no extra EAC grant needed).

---

## 4. The three capabilities (with signed headers)

Every submission update goes through the World Chain gate, so the backend can
verify the *sender* is the same wallet that owns the agent:

| Capability                    | Wallet          | Human-backed | Verified by   |
| ----------------------------- | --------------- | ------------ | ------------- |
| requestCreditRoundtrip        | `0x...E26b`     | no           | World signed header |
| requestCreditRoundtrip        | `0x...0669`     | yes          | World signed header |
| requestCreditRoundtrip        | `0x...8F4e`     | yes          | World signed header |
| lendToAgency                   | `0x...8F4e`     | yes          | World signed header |

---

## 5. SDK surface we use

| SDK helper                         | Our usage |
| ---------------------------------- | --------- |
| `createAgentBookVerifier`           | on-chain AgentBook lookup oracle |
| `lookupHuman(address)`              | `humanBacked` + `humanId` resolution |
| `parseAgentkitHeader`               | parse a raw World header into a signed payload |
| `validateAgentkitMessage`           | ensure the signed payload targets us (SIWE/EIP-712 envelope) |
| `verifyAgentkitSignature`           | recover the signing wallet from the header |
| `createAgentkitClient` + `signer`   | read the agent's AgentBook entry from the agent's POV |
| `declareAgentkitExtension`          | context for non-AgentBook identity data |

We call these from `integrations/world/`. There is **no AgentKit payment
middleware** here — we needed the *identity* surface, not per-request
charging.

---

## 6. Verification commands (reproducible)

```bash
# read-only AgentBook lookup for any wallet
node integrations/world/agent-provision.js status 0x<address>

# ENS mint with World-derived humanBacked (needs Sepolia env)
node integrations/ens/register-single-agent.js trader 0x<controller>

# on-chain push + optional ENS identity records
node integrations/world/verify-agent.js 0x<controller> --ens-name trader.agentcreditbure.us.seth

# bot-vs-human gate (needs running backend)
node integrations/world/agent-client.js gate 0x<controller>
```

Each of these is deterministic and idempotent: re-running `status` returns the
same human-id for a registered wallet, and the gate recomputes rather than
caches the lookup.

---

## 7. World Chain gate

The gate lives behind the connector under `/api/world/gate`. It accepts a
`POST` with a World-signed header and does, in order:

1. `verifyAgentkitSignature(header, resourceUri)` — recover the signer. If the
   header is absent or bad ⇒ route is bot-only (see policy).
2. `createAgentBookVerifier().lookupHuman(signer)` — live AgentBook lookup
   each call (no caching, so revocation is honored). `humanBacked=null` for a
   registered-but-not-human-backed wallet, or an RPC error is folded to
   fail-closed.
3. **Policy per route**:
   - `POST /api/world/gate?verifyAgent=…` (read-only): any registered wallet. A
     *registered* wallet's human context is returned; an *unregistered* wallet
     is also allowed (but scored lower — no human bonus).
   - Mutations are gated more strictly (the demo's `lendToAgency` requires a
     registered + human-backed wallet).
4. If verified and registered, resolves `verifyAgentkitMessage(payload,
   resourceUri).humanId` and attaches `{ humanBacked, humanId }` to the
   response and (for mutations) to the CreditBureau write.

A World *App* proof (the World App "connect" screen) is what the demo's
`agent-client.js` produces; the World Chain flows use the same header via
`worldcoin.org/connect`.

---

## 8. Human verification UI (dashboard)

The dashboard exposes a "Verify World" flow: it re-runs the AgentBook lookup
for the agent's controller wallet and shows:

- **Registered in AgentBook** with the **anonymous human ID** (last 6 of the
  hashed id, so it's readable but not revealing).
- **Human-backed** vs **Bot-only** badge.
- A **Revocation** action (re-checks AgentBook and, if the wallet is no longer
  registered, flips `humanBacked` to `false` and updates the ENS records and
  `CreditBureauSync`).

Use the Sandbox App (World App) from the Developer Portal to mint the human
backing *before* the dashboard reflects it.

---

## 9. MCP / report integration

- The report (used by the MCP server) includes
  `humanBacked: <agentbook-lookup.result.humanBacked>`.
- The subgraph indexer reads `HumanBackingSet` events from
  `CreditBureauSync` and stores the `humanBacked` flag per-agent.
- `lookupHuman` expects the controller wallet; if you pass an ENSv2 name that
  doesn't yet resolve to an address, the gate falls back to the agent's
  `controllerAddress` on the wallet record.

---

## 9b. World Selfie Check (scratch track — the other World credential)

Selfie Check (Beta) is a **medium-assurance** biometric credential — device
camera liveness + facial similarity, **no Orb** — integrated for the Selfie
Check prize track (`docs/selfie-check-feedback.md` is the required feedback
artifact). It is deliberately distinct from AgentBook: no uniqueness claim, so
we use it for **abuse prevention / continuity / eligibility** rather than
one-person-one-identity.

Flow:

1. `POST /api/world/selfie/sign` — backend signs the IDKit request with the
   RP signing key (`signRequest` from `@worldcoin/idkit-core/signing`); the
   key never leaves `.env` (`WORLD_RP_SIGNING_KEY`).
2. Frontend builds `IDKit.request({...}).preset(selfieCheckLegacy({ signal }))`
   where `signal` = the agent controller; renders `connectorURI` as a QR/deep
   link, polls `pollUntilCompletion()`.
3. `POST /api/world/selfie/verify` — backend forwards the IDKit result to
   `POST /api/v4/verify/{rp_id}`, enforces the action binding
   (`credence-selfie-<controller>`) and nullifier reuse, records the
   credential, writes `world.selfiecheck.*` ENS records and flips
   `CreditBureau.setHumanBacking` (score bonus).

Operation notes:

- **Access-gated Beta**: the Selfie Check feature flag must be enabled for
  your Developer Portal app (via your World contact) before real proofs work.
- **Environments**: production → `developer.world.org/api/v4/verify/`;
  staging/sandbox → `staging-developer.worldcoin.org/...` (use the
  simulator or sandbox World ID app). Set `WORLD_ID_ENVIRONMENT`.
- **Demo mode**: `WORLD_ID_MOCK=1` completes the full request→QR→verify loop
  with a clearly-labeled simulated credential (`environment: demo-mock`) so
  the app demos end-to-end before the flag lands. Never run in production.
- Required env: `WORLD_RP_SIGNING_KEY`, `WORLD_ID_APP_ID` (falls back to
  `WORLD_APP_ID`), `WORLD_ID_RP_ID`, `WORLD_ID_ENVIRONMENT`.

---

## 10. Where AgentBook fits in the prize

| Prize gate                         | How AgentBook/World makes it true |
| ---------------------------------- | --------------------------------- |
| **Human-over-AI veil**             | Agents shot in AgentBook are provably distinct from humans (or provably bot-only) |
| **Tenant + cross-chain identity**  | AgentBook is chain-anchored; ENSv2 gives the agent a first-class identity in Credence |
| **Credit score soul-bounded**      | `humanBacked` + `humanId` are written into the ENSv2 resolver *and* on-chain via CreditBureauSignature |
| **Government-grade identity**      | World App proof flow is interactive-human by design (AgentBook requires an interactive proof on registration) |
| **Fraud resistance**               | Compliant agents are human-backed; non-backed agents pay a Sybil-risk premium |

---

## 11. Debugging flows

- **"registered but human=0" vs "RPC error"**: the gate treats both as
  `humanBacked:false` (fail-closed), which is also what the prize reads as
  "no human backing". If you saw `null` in a status check, you're looking at
  an unregistered wallet — re-run `agent-provision.js status` against a
  wallet that actually completed the Sandbox App flow.
- **URI mismatch**: `verifyAgentkitMessage(payload, resourceUri)` requires the
  caller's resourceUri to match what was signed. If you see `uri mismatch`,
  the header was signed with a different service Uri. Our gate echoes the
  client-provided `resourceUri` back (see `agent-client.js`).
- **World App proof can't run headlessly**: `agentkit-cli register` is
  interactive by design (World App proof). Use the **Sandbox App** for remote
  testing; a real wallet needs the interactive World App (a human step).
- **Slow lookups**: `createAgentBookVerifier()` without an explicit `rpcUrl`
  uses the default public World Chain RPC, which can be slow/rate-limited from
  some regions. Set `WORLD_CHAIN_RPC_URL` in `.env` to override everywhere
  we construct the verifier.

---

## 12. References

- [AgentKit Python Integration Guide](https://docs.world.org/agents/agent-kit/integrate)
  (Language-agnostic: SDK, AgentBook, verification).
- [World AgentKit docs](https://docs.world.org/agents/agent-kit)
- [World Verified Human Standard](https://docs.world.org/standard/overview)
- [World ID docs](https://id.worldcoin.org/verify)
- [World Developer Portal](https://worldcoin.org/agents)

---

*Written during ETHOnline 2026 by the Credence team. We used the Sandbox App
for proof-flow testing; production AgentBook registration for real wallets goes
through the World App proof flow as designed.*
