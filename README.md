# 🛡️ Credence — Onchain Credit Infrastructure for Autonomous Agents

Credence is an onchain reputation and credit-scoring layer for autonomous
agents. The name means trusted belief backed by
evidence: agents get a portable identity, prove a real human backs them,
build a live credit score from transaction history, and unlock graduated
spend limits. A credit-enforcing escrow uses that limit at settlement time,
while an AI analyst explains live Graph data; on Hedera, AI agents PAY for
that analyst per call in HBAR (x402 via Blocky402) and the same live score
prices the ATS tokenization of their receivables at a discount.

## The system

| Piece | Sponsor | Role |
|---|---|---|
| Identity | ENSv2 | Each agent is a named subname (`trader.agentcreditbureau.eth`) with role-based permissions via Enhanced Access Control. |
| Human backing | World | AgentKit proves a unique real human stands behind the agent, blocking Sybil farming. **Sandbox-only**: the World ID SANDBOX (staging) is used end-to-end — AgentBook registration for the identity mint runs against the labeled sandbox registry (`backend/integrations/world/agentbook-sandbox.js`), never production World IDs. |
| History → Score | The Graph | Indexes on-chain outcomes (payments, defaults, disputes) into a live, queryable credit score. |
| Enforcement | CreditEscrow | Payments are rejected when they exceed the agent's current on-chain credit limit. |
| **Receivables market** | **Hedera ATS** | **The agent's outstanding invoices are tokenized and sold to liquidity providers at a discount rate priced off the credit score — issued as ATS bonds, compliance-enforced transfer to LPs, redeemed at maturity (incl. Scheduled Transactions).** |
| **Agent payments** | **Hedera x402** | **AI agents pay per credit call in HBAR (100 tinybar) through the Blocky402 facilitator — no API key, no seats; the MCP platform consumes the same x402 service.** |
| Underwriting | The Graph + AI | A live subgraph report produces an explainable approve, monitor, or decline recommendation. |

## Repo layout

```
contracts/         Solidity: CreditBureau.sol + CreditEscrow.sol — scoring and settlement enforcement
subgraph/           The Graph subgraph indexing CreditBureau events into a live report
backend/integrations/ens/   ENSv2 subname registration + registry-based EAC permissions
backend/integrations/world/ World AgentKit AgentBook status verification
backend/integrations/graph/ Live Graph-powered credit analyst
backend/integrations/hedera/ Hedera: ATS receivable issuance + full lifecycle (transfer, redemption, Scheduled Transactions) and the x402 pay-per-call credit service (server, buyer agent, autonomous agent-demo)
backend/integrations/mcp/     MCP server: agents pull the live credit report in natural language
backend/integrations/bazantic/ Recipes + evidence harness so AI agents can use the credit bureau
simulator/          Scripts to generate a believable transaction history for the demo
frontend/           React dashboard: "pull a credit report" for any agent
docs/               Demo script and architecture notes
```

## Quickstart

```bash
# 0. ENSv2 namespace (ONCE per project) — REQUIRED BEFORE the contracts
#    deploy: CreditBureau pins the project's ENSv2 UserRegistry at
#    construction, and every agent registration is verified against it.

# first set ENSV2_PAYMENT_TOKEN in .env (an ERC20 the hackathon registrar accepts)
node backend/integrations/ens/setup-agent-namespace.js agentcreditbureau
#    -> registers agentcreditbureau.eth, deploys your UserRegistry proxy,
#       attaches it (setSubregistry), deploys AgentSubnameRegistrar and grants
#       it ROLE_REGISTRAR + ROLE_RENEW
#    -> prints ENS_AGENT_REGISTRY_ADDRESS and ENS_AGENT_REGISTRAR_ADDRESS —
#       save both into .env (and frontend/.env for the VITE_* copies)

# 1. Contracts (from the repo root)
cd contracts
npm install
# Create .env from ../.env.example and fill in your credentials plus the
# ENS_AGENT_REGISTRY_ADDRESS from step 0.
npm run compile
npm test
npm run deploy:sepolia    # deploys CreditBureau (pinned to the ENS registry) + CreditEscrow, then writes deployments/sepolia.json

# 2. Subgraph
cd ../subgraph
# update the deployed address and startBlock from the deployment artifact
node ../contracts/scripts/prepare-subgraph-config.js
graph codegen && graph build
# Create a Graph Studio subgraph, set its endpoint in frontend/.env, then deploy.
graph deploy agent-credit-bureau

# 3. AI credit analyst against the live Graph endpoint
cd ..
GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/1758802/agent-credit-bureau/version/latest \
node backend/integrations/graph/credit-analyst.js 0x<agent-address>


# Optional model narrative; the deterministic recommendation works without it.
OPENAI_API_KEY=... GRAPH_ENDPOINT=... \
node backend/integrations/graph/credit-analyst.js 0x<agent-address>

# 3b. Graph composition (ETHOnline 2026 composable/standardized track):
#     cross-protocol intel + the official Subgraph MCP need a free Gateway
#     API key (https://thegraph.com/studio/) set as GRAPH_API_KEY in .env.
cd ../backend/integrations/graph   # modules: standardized-intel.js, graph-stack.js
node --check standardized-intel.js # quick sanity
# exercise from the backend:
curl http://127.0.0.1:8787/api/graph/stack            # stack status (per-leg)
curl -X POST http://127.0.0.1:8787/api/graph/intel \
  -H 'content-type: application/json' -d '{}'         # market-wide intel
curl -X POST http://127.0.0.1:8787/api/graph/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"discover the top subgraphs indexing contract 0x…"}'
# Same capabilities as MCP tools: get_market_intel + ask_graph_network
cd ../mcp && npm run smoke

# 4. Mint an agent identity (per agent): WORLD AGENTBOOK REGISTRATION FIRST,
#    then resolver + subname + EAC scope. `humanBacked` is derived from the
#    AgentBook registration result (true only when registration succeeded).
#    Runs on the World ID SANDBOX (staging) — labeled mock credentials, no
#    production World IDs.
#    ENS_AGENT_REGISTRAR_ADDRESS and CREDIT_BUREAU_ADDRESS come from .env
node backend/integrations/ens/register-single-agent.js trader 0x<agent-controller>
#    (optionally pass registrar + bureau + root explicitly as positional args)
#    If the controller isn't the deployer, set CONTROLLER_PRIVATE_KEY in .env —
#    grantSetterRoles() must be sent by the controller wallet.

# 4b. Then the CONTROLLER registers with the bureau (verified on-chain through
#     the ENS registry; the frontend does this inline with one click) and the
#     bureau writes the initial spend limit into the agent's own resolver text
#     records via its scoped EAC role.

# 5. Simulator (append history to an already-registered demo agent; register
#    via the frontend "Register identity" flow first)
cd simulator
node simulate-agent.js good 60      # climb the score
node simulate-agent.js default 1    # trigger a freeze, on a second agent

# 6. Hedera: x402 agent payments + ATS receivable lifecycle
cd ../backend/integrations/hedera
npm install
npm run check
node scripts/tokenize-receivable.js 0xAgentController 1000 30    # issue receivable bond at score-priced discount
node scripts/quote-factoring.js 0xAgentController                 # the credit oracle price
node scripts/transfer-receivable.js <token> <lp> <units>          # LP purchase (compliance-enforced)
node scripts/redeem-at-maturity.js <token> <lp> <units>           # redemption at maturity
node scripts/schedule-maturity-settlement.js <token> <lp> <units> # Scheduled Transaction maturity settlement
# x402 pay-per-call credit services (full flow: docs/hedera-tracks.md)
npm run start:x402                                             # 402-gated credit report + factoring rate service
node x402/buyer.js 0xAgentController report                    # consuming agent pays per call in HBAR
node x402/agent-demo.js 0xAgentController                      # discover -> pay -> consume -> decide

# 7. Frontend
cd ../../../frontend
npm install
cp .env.example .env   # fill in VITE_CREDIT_BUREAU_ADDRESS, VITE_SUBGRAPH_URL, VITE_RPC_URL, VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS
npm run dev

# 8. MCP credit-report server (agent-facing The Graph tooling)
cd ../backend/integrations/mcp
npm install
GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest \
node server.js        # stdio MCP server; wire into Claude Desktop / Cursor / any agent SDK

# 9. Show the same flow through the Bazantic recipes (The Graph + Hedera)
cd ../bazantic
OPENAI_API_KEY=... node evidence/compare.js 0x<real-controller-address>
```

## Submission-ready live deployment checklist

Use this exact sequence for a sponsor-grade demo and to capture real evidence before submission. The ENSv2 namespace is step 1 because CreditBureau, the subgraph's identity source, and the whole agent flow depend on it.

1. Create the project's ENSv2 namespace on Sepolia (run ONCE).
   ```bash
   # from the repo root
   cd backend/integrations/ens
   node setup-agent-namespace.js agentcreditbureau
   # (requires ENSV2_PAYMENT_TOKEN in .env, then registers the root .eth name,
   #  deploys the project UserRegistry + AgentSubnameRegistrar, grants roles)
   # Copy the printed ENS_AGENT_REGISTRY_ADDRESS + ENS_AGENT_REGISTRAR_ADDRESS
   # into .env and frontend/.env.
   ```

2. Deploy the bureau and escrow on Sepolia, pinned to that registry.
   ```bash
   # from the repo root
   cd contracts
   npm run deploy:sepolia
   ```
   This writes `contracts/deployments/sepolia.json` with a timestamped deployment artifact.

3. Update the subgraph config to match the deployed bureau address.
   ```bash
   # from the repo root
   cd subgraph
   node ../contracts/scripts/prepare-subgraph-config.js
   graph codegen && graph build
   ```

4. Deploy the subgraph to The Graph Studio and set the live endpoint.
   ```bash
   # from the repo root
   cd subgraph && graph deploy agent-credit-bureau
   ```

5. Register a real ENSv2 agent identity on Sepolia and pin it to the bureau.
   ```bash
   # from the repo root
   node backend/integrations/ens/register-single-agent.js trader 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
   # (+ set CONTROLLER_PRIVATE_KEY when the controller is not the deployer, or
   #   run the frontend's "Mint an agent identity" flow from the controller wallet)
   ```

6. Verify a real human-backed agent with World AgentKit/AgentBook and push
   the proof on-chain. SANDBOX: verify-agent.js reads the labeled sandbox
   AgentBook (WORLD_ID_ENVIRONMENT=staging) — it never hits production World
   Chain unless both WORLD_ID_ENVIRONMENT=production and
   WORLD_ALLOW_PRODUCTION=1 are set explicitly.
   ```bash
   # from the repo root
   node backend/integrations/world/verify-agent.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
   ```

7. Run the Graph analyst using the live endpoint and capture the output.
   ```bash
   # from the repo root
   GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/<slug>/version/latest \
   node backend/integrations/graph/credit-analyst.js 0xYourController
   ```

8. Tokenize a receivable on Hedera testnet using the live bureau score, then
   run the x402 agent-payment loop (docs/hedera-tracks.md has the evidence
   checklist for both Hedera tracks).
   ```bash
   # from the repo root
   cd backend/integrations/hedera
   node scripts/tokenize-receivable.js 0xYourController 1000 30
   node scripts/transfer-receivable.js <token> <lp> <units>
   node scripts/schedule-maturity-settlement.js <token> <lp> <units> contract
   npm run start:x402        # then, in another shell:
   node x402/agent-demo.js 0xYourController
   ```

9. Capture the proof artifacts:
   - Sepolia Etherscan transactions
   - Graph Studio query output
   - Hedera issuance transaction ID
   - frontend screenshot showing the live credit report

This is the evidence bundle judges expect to see when submitting for ENS, World, The Graph, and Hedera.

### Required configuration


Start from [.env.example](.env.example). Never commit private keys or API
secrets. The external flows require additional deployment-specific values:

- `ENSV2_PAYMENT_TOKEN`: an ERC20 token the hackathon ETHRegistrar accepts when
  registering the project's root `.eth` name. Required by
  `setup-agent-namespace.js` — it fails without it.
- `ENS_AGENT_REGISTRY_ADDRESS` and `ENS_AGENT_REGISTRAR_ADDRESS`: the project
  UserRegistry and AgentSubnameRegistrar — printed by
  `setup-agent-namespace.js` once it runs. `ENS_AGENT_REGISTRY_ADDRESS` is
  required by `npm run deploy:sepolia` (the bureau constructor pins it);
  `ENS_AGENT_REGISTRAR_ADDRESS` is used by `register-single-agent.js`, the
  simulator, and the frontend.
- `CREDIT_BUREAU_ADDRESS`: written by the contracts deployment output.
- `GRAPH_ENDPOINT` or `VITE_SUBGRAPH_URL`: a live Graph provider endpoint.
- `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `ATS_FACTORY_ADDRESS`, and
  `ATS_RESOLVER_ADDRESS`: Hedera testnet ATS configuration.
- `X402_PAYER_ACCOUNT` + `X402_PAYER_KEY` (or reuse `HEDERA_OPERATOR_ID`/
  `HEDERA_OPERATOR_KEY`): the consuming agent wallet that pays per credit
  call on the x402 service; top up at https://portal.hedera.com.
- `WORLD_APP_ID`: AgentKit/AgentBook setup; **SANDBOX ONLY** —
  `WORLD_ID_ENVIRONMENT=staging` routes all AgentBook lookups/registrations
  through the labeled sandbox registry (`backend/integrations/world/agentbook-sandbox.js`);
  production World Chain is hard-disabled unless both `WORLD_ID_ENVIRONMENT=production`
  and `WORLD_ALLOW_PRODUCTION=1` are set. The world script fails closed when the
  wallet is not registered.
- `AGENT_PRIVATE_KEY`: the simulator's throwaway demo-agent wallet.
- `CONTROLLER_PRIVATE_KEY`: needed by `register-single-agent.js` to run
  `grantSetterRoles()` as the agent controller when it is not the deployer.
- `VITE_ESCROW_ADDRESS` + `VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS`:
  needed by the frontend for credit-limited settlement and in-browser ENSv2
  registration.

## End-to-end flow

```text
ENSv2 namespace setup (once): register root .eth name, deploy UserRegistry,
   attach via setSubregistry, deploy AgentSubnameRegistrar, grant it roles
   -> per-agent: Permissioned Resolver via VerifiableFactory
   -> AgentSubnameRegistrar mints <label>.agentcreditbureau.eth
   -> agent grants CreditBureau ROLE_SET_TEXT scoped to the spend-limit key
   -> CreditBureau.registerAgent() verifies subname ownership via the registry
   -> CreditBureau writes the spend limit into the agent's own resolver
      text record through that scoped EAC role (every limit change)
   -> CreditEscrow.settleJob() enforces the current limit on-chain
   -> CreditBureau records the outcome and updates score
   -> The Graph indexes the credit report
   -> AI analyst recommends approve, monitor, or decline
   -> Hedera ATS issues an eligible receivable token
```

`CreditEscrow` is the executable enforcement boundary: it checks
`CreditBureau.isCreditworthy()` before forwarding payment and is authorized as
a reporter during deployment. The ENSv2 limb is real end-to-end on Sepolia:
the bureau verifies each agent's subname on-chain (`getOwner` on the project
UserRegistry), captures the agent's own Permissioned Resolver, and only ever
writes to the single `com.agentcreditbureau.spend-limit-wei` text record it was
granted via `grantSetterRoles()` — the agent can revoke that at any time
The Graph analyst uses indexed outcomes and returns deterministic evidence
even when no model API key is configured.

## Validation

The repository currently validates with:

```bash
cd contracts && npm test                 # 9 passing tests (incl. ENS ownership + EAC write path)
cd ../frontend && npm run build          # Vite production build
cd ../subgraph && graph codegen && graph build
cd ../backend/integrations/hedera && npm run check
cd ../backend/integrations/mcp && npm run smoke  # end-to-end MCP round trip (mock subgraph)
cd ../mcp && node cli.js tools                    # list the MCP tools, runnable from scripts
```

Live ENSv2 registration, World AgentBook verification, Graph queries, and ATS
issuance require valid network credentials and deployment addresses.

### Frontend capabilities (frontend/src/App.jsx)

The dashboard runs the full stack with env-driven addresses (frontend/.env): a
live config strip, identity minting (ENSv2 resolver + subname + EAC scope),
credit-limited escrow settlement, the on-chain + subgraph credit report with
score/limit history, the Graph credit analyst's evidence-backed decision
(approve / monitor / decline, optional AI narrative), live runs of all three
MCP tools (list_agents, get_agent_report, get_factoring_rate) with the exact
payload an AI agent receives, and a capability index across the whole stack.

## On-chain proof: deployed contracts

The following addresses are the live deployment evidence for the Credence
demo. Each explorer link opens the contract or Hedera entity directly so
judges can verify bytecode, transactions, events, and relationships on-chain.

### Credence contracts — Ethereum Sepolia

| Contract | Network | Address | Explorer |
|---|---|---|---|
| CreditBureau | Ethereum Sepolia | `0xc7b70Ad30e0eDEB369022C0Cb0AC611f2754f3eb` | [Etherscan](https://sepolia.etherscan.io/address/0xc7b70Ad30e0eDEB369022C0Cb0AC611f2754f3eb) |
| CreditEscrow | Ethereum Sepolia | `0x098CEc4c453402B82726cE5E484ef1978d2D6a38` | [Etherscan](https://sepolia.etherscan.io/address/0x098CEc4c453402B82726cE5E484ef1978d2D6a38) |

Deployment artifact: [`contracts/deployments/sepolia.json`](contracts/deployments/sepolia.json).

### ENSv2 contracts — Ethereum Sepolia

| Contract | Network | Address | Explorer |
|---|---|---|---|
| Project UserRegistry proxy | Ethereum Sepolia | `0x909f6ab79df535f07d700acdb38c26316b1cc644` | [Etherscan](https://sepolia.etherscan.io/address/0x909f6ab79df535f07d700acdb38c26316b1cc644) |
| AgentSubnameRegistrar | Ethereum Sepolia | `0xB3505c1E5abd5AC10d9108f174e63B0BEfc45f47` | [Etherscan](https://sepolia.etherscan.io/address/0xB3505c1E5abd5AC10d9108f174e63B0BEfc45f47) |
| ETHRegistry | Ethereum Sepolia | `0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e` | [Etherscan](https://sepolia.etherscan.io/address/0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e) |
| ETHRegistrar | Ethereum Sepolia | `0x7d1b7f586a62ac3f54b9a396849757814283270b` | [Etherscan](https://sepolia.etherscan.io/address/0x7d1b7f586a62ac3f54b9a396849757814283270b) |
| VerifiableFactory | Ethereum Sepolia | `0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780` | [Etherscan](https://sepolia.etherscan.io/address/0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780) |
| UserRegistry implementation | Ethereum Sepolia | `0x47b442d0cf617c41cabaff5f02f44dd1e5f72546` | [Etherscan](https://sepolia.etherscan.io/address/0x47b442d0cf617c41cabaff5f02f44dd1e5f72546) |
| PermissionedResolver implementation | Ethereum Sepolia | `0xa9d3814ab151bf6e37a427432795371a8361614e` | [Etherscan](https://sepolia.etherscan.io/address/0xa9d3814ab151bf6e37a427432795371a8361614e) |
| PublicResolverV2 | Ethereum Sepolia | `0xf9de4979ddb290baf5b760d0e788125017bc33f6` | [Etherscan](https://sepolia.etherscan.io/address/0xf9de4979ddb290baf5b760d0e788125017bc33f6) |
| UpgradableUniversalResolverProxy | Ethereum Sepolia | `0xd26f2040d083af1cd2962ba303f4bea0c4faf142` | [Etherscan](https://sepolia.etherscan.io/address/0xd26f2040d083af1cd2962ba303f4bea0c4faf142) |

### Hedera ATS contracts — Hedera testnet

| Contract | Network | Hedera ID | Explorer |
|---|---|---|---|
| ATS Factory | Hedera testnet | `0.0.9213391` | [HashScan](https://hashscan.io/testnet/contract/0.0.9213391) |
| ATS Resolver | Hedera testnet | `0.0.9212226` | [HashScan](https://hashscan.io/testnet/contract/0.0.9212226) |

Receivable bonds are created dynamically on Hedera testnet by
`tokenize-receivable.js`; each issuance returns a new bond address and
transaction ID, which can be opened on HashScan from the command output.
Per-agent Permissioned Resolver proxies are also created dynamically by
`register-single-agent.js` and are not a single shared contract address.

### The Graph subgraph — Sepolia index

| Item | Value |
|---|---|
| Subgraph | `agent-credit-bureau` |
| Graph Studio deployment ID | `1758802` |
| Network indexed | Ethereum Sepolia |
| Source contract | [`CreditBureau`](https://sepolia.etherscan.io/address/0xc7b70Ad30e0eDEB369022C0Cb0AC611f2754f3eb) |
| Indexed from block | `11675965` |
| Live query endpoint | [`api.studio.thegraph.com/query/1758802/agent-credit-bureau/version/latest`](https://api.studio.thegraph.com/query/1758802/agent-credit-bureau/version/latest) |
| Schema | [`subgraph/schema.graphql`](subgraph/schema.graphql) |
| Mapping | [`subgraph/src/mapping.ts`](subgraph/src/mapping.ts) |

The subgraph turns on-chain CreditBureau events into a queryable credit
history: `Agent`, `Outcome`, `ScoreSnapshot`, and `SpendLimitChange` entities.
It indexes `AgentRegistered`, `HumanBackingUpdated`, `OutcomeRecorded`,
`ScoreUpdated`, `SpendLimitUpdated`, `AgentFrozen`, and `AgentUnfrozen`.

## ENSv2 hackathon deployment

The ENS integration targets the dedicated ETHOnline ENSv2 beta deployment on
Sepolia. EAC roles are implemented by the registry and resolver and are not
managed through a separate EAC contract. The canonical ENSv2 address registry
with explorer links is listed above.

Project-owned deployments:

| Contract | Where | Created by |
|---|---|---|
| UserRegistry proxy | `ENS_AGENT_REGISTRY_ADDRESS` | `setup-agent-namespace.js` (Verifiable Factory) |
| AgentSubnameRegistrar | `ENS_AGENT_REGISTRAR_ADDRESS` | `setup-agent-namespace.js` (plain deploy) |
| Per-agent Permissioned Resolver proxy | per controller | `register-single-agent.js` / frontend / simulator |


See `docs/architecture.md`, `docs/demo-script.md` (CLI walkthrough) and
`docs/demo-script-frontend.md` — the 4-minute, frontend-driven video script
(problem pitch, cast of agents, ENS names, Hedera credential prep, evidence
bundle) — for the day-of-demo walkthrough. The Hedera prize requirement
mapping lives in `docs/hedera-tracks.md`.
