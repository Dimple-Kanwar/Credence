# 🛡️ Credence — Onchain Credit Infrastructure for Autonomous Agents

Credence is an onchain reputation and credit-scoring layer for autonomous
agents. The name means trusted belief backed by
evidence: agents get a portable identity, prove a real human backs them,
build a live credit score from transaction history, and unlock graduated
spend limits. A credit-enforcing escrow uses that limit at settlement time,
while an AI analyst explains live Graph data and Hedera ATS can tokenize
eligible receivables at a score-priced discount.

## The system

| Piece | Sponsor | Role |
|---|---|---|
| Identity | ENSv2 | Each agent is a named subname (`trader.agentcreditbureau.eth`) with role-based permissions via Enhanced Access Control. |
| Human backing | World | AgentKit proves a unique real human stands behind the agent, blocking Sybil farming. |
| History → Score | The Graph | Indexes on-chain outcomes (payments, defaults, disputes) into a live, queryable credit score. |
| Enforcement | CreditEscrow | Payments are rejected when they exceed the agent's current on-chain credit limit. |
| **Receivables market** | **Hedera ATS** | **The agent's outstanding invoices are tokenized and sold to liquidity providers at a discount rate priced off the credit score.** |
| Underwriting | The Graph + AI | A live subgraph report produces an explainable approve, monitor, or decline recommendation. |

## Repo layout

```
contracts/         Solidity: CreditBureau.sol + CreditEscrow.sol — scoring and settlement enforcement
subgraph/           The Graph subgraph indexing CreditBureau events into a live report
integrations/ens/   ENSv2 subname registration + registry-based EAC permissions
integrations/world/ World AgentKit AgentBook status verification
integrations/graph/ Live Graph-powered credit analyst
integrations/hedera/ Hedera Asset Tokenization Studio receivable issuance
integrations/mcp/     MCP server: agents pull the live credit report in natural language
integrations/bazantic/ Recipes + evidence harness so AI agents can use the credit bureau
simulator/          Scripts to generate a believable transaction history for the demo
frontend/           React dashboard: "pull a credit report" for any agent
docs/               Demo script and architecture notes
```

## Quickstart

```bash
# 0. ENSv2 namespace (ONCE per project) — REQUIRED BEFORE the contracts
#    deploy: CreditBureau pins the project's ENSv2 UserRegistry at
#    construction, and every agent registration is verified against it.

# first set ENSV2_PAYMENT_TOKEN in ../.env (an ERC20 the hackathon registrar accepts)
node integrations/ens/setup-agent-namespace.js agentcreditbureau
#    -> registers agentcreditbureau.eth, deploys your UserRegistry proxy,
#       attaches it (setSubregistry), deploys AgentSubnameRegistrar and grants
#       it ROLE_REGISTRAR + ROLE_RENEW
#    -> prints ENS_AGENT_REGISTRY_ADDRESS and ENS_AGENT_REGISTRAR_ADDRESS —
#       save both into ../.env
cd ..

# 1. Contracts
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
node integrations/graph/credit-analyst.js 0x<real-controller-address>

# Optional model narrative; the deterministic recommendation works without it.
OPENAI_API_KEY=... GRAPH_ENDPOINT=... \
node integrations/graph/credit-analyst.js 0x<real-controller-address>

# 4. Mint an agent identity (per agent): resolver + subname + EAC scope
#    ENS_AGENT_REGISTRAR_ADDRESS and CREDIT_BUREAU_ADDRESS come from .env
node ../integrations/ens/register-single-agent.js trader 0x<agent-controller>
#    (optionally pass registrar + bureau + root explicitly as positional args)
#    If the controller isn't the deployer, set CONTROLLER_PRIVATE_KEY in .env —
#    authorizeTextRoles() must be sent by the controller wallet.

# 4b. Then the CONTROLLER registers with the bureau (verified on-chain through
#     the ENS registry; the frontend does this inline with one click) and the
#     bureau writes the initial spend limit into the agent's own resolver text
#     records via its scoped EAC role.

# 5. Simulator (populate a demo agent's history; mints a fresh ENSv2 identity)
cd ../simulator
node simulate-agent.js good 60      # climb the score
node simulate-agent.js default 1    # trigger a freeze, on a second agent

# 6. Hedera ATS receivable issuance
cd ../integrations/hedera
npm install
npm run check
node scripts/tokenize-receivable.js 0xAgentController 1000 30

# 7. Frontend
cd ../frontend
npm install
cp .env.example .env   # fill in VITE_CREDIT_BUREAU_ADDRESS, VITE_SUBGRAPH_URL, VITE_RPC_URL, VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS
npm run dev

# 8. MCP credit-report server (agent-facing The Graph tooling)
cd ../integrations/mcp
npm install
GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/agent-credit-bureau/version/latest \
node server.js        # stdio MCP server; wire into Claude Desktop / Cursor / any agent SDK

# 9. Show the same flow through the Bazantic recipes (The Graph + Hedera)
cd ../integrations/bazantic
OPENAI_API_KEY=... node evidence/compare.js 0x<real-controller-address>
```

## Submission-ready live deployment checklist

Use this exact sequence for a sponsor-grade demo and to capture real evidence before submission. The ENSv2 namespace is step 1 because CreditBureau, the subgraph's identity source, and the whole agent flow depend on it.

1. Create the project's ENSv2 namespace on Sepolia (run ONCE).
   ```bash
   cd integrations/ens
   node setup-agent-namespace.js agentcreditbureau
   # (requires ENSV2_PAYMENT_TOKEN in .env, then registers the root .eth name,
   #  deploys the project UserRegistry + AgentSubnameRegistrar, grants roles)
   # Copy the printed ENS_AGENT_REGISTRY_ADDRESS + ENS_AGENT_REGISTRAR_ADDRESS
   # into .env and frontend/.env.
   ```

2. Deploy the bureau and escrow on Sepolia, pinned to that registry.
   ```bash
   cd contracts
   npm run deploy:sepolia
   ```
   This writes `contracts/deployments/sepolia.json` with a timestamped deployment artifact.

3. Update the subgraph config to match the deployed bureau address.
   ```bash
   cd ../subgraph
   node ../contracts/scripts/prepare-subgraph-config.js
   graph codegen && graph build
   ```

4. Deploy the subgraph to The Graph Studio and set the live endpoint.
   ```bash
   graph deploy agent-credit-bureau
   ```

5. Register a real ENSv2 agent identity on Sepolia and pin it to the bureau.
   ```bash
   node ../integrations/ens/register-single-agent.js trader 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
   # (+ set CONTROLLER_PRIVATE_KEY when the controller is not the deployer, or
   #   run the frontend's "Mint an agent identity" flow from the controller wallet)
   ```

6. Verify a real human-backed agent with World AgentKit/AgentBook and push the proof on-chain.
   ```bash
   node ../integrations/world/verify-agent.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
   ```

7. Run the Graph analyst using the live endpoint and capture the output.
   ```bash
   GRAPH_ENDPOINT=https://api.studio.thegraph.com/query/<id>/<slug>/version/latest \
   node integrations/graph/credit-analyst.js 0xYourController
   ```

8. Tokenize a receivable on Hedera testnet using the live bureau score.
   ```bash
   cd integrations/hedera
   node scripts/tokenize-receivable.js 0xYourController 1000 30
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
- `WORLD_APP_ID`: AgentKit/AgentBook setup; the World script checks live
  AgentBook status and fails closed when the wallet is not registered.
- `AGENT_PRIVATE_KEY`: the simulator's throwaway demo-agent wallet.
- `CONTROLLER_PRIVATE_KEY`: needed by `register-single-agent.js` to run
  `authorizeTextRoles()` as the agent controller when it is not the deployer.
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
granted via `authorizeTextRoles()` — the agent can revoke that at any time
The Graph analyst uses indexed outcomes and returns deterministic evidence
even when no model API key is configured.

## Validation

The repository currently validates with:

```bash
cd contracts && npm test                 # 9 passing tests (incl. ENS ownership + EAC write path)
cd ../frontend && npm run build          # Vite production build
cd ../subgraph && graph codegen && graph build
cd ../integrations/hedera && npm run check
cd ../integrations/mcp && npm run smoke  # end-to-end MCP round trip (mock subgraph)
```

Live ENSv2 registration, World AgentBook verification, Graph queries, and ATS
issuance require valid network credentials and deployment addresses.

## ENSv2 hackathon deployment

The ENS integration targets the dedicated ETHOnline ENSv2 beta deployment on
Sepolia. EAC roles are implemented by the registry and resolver and are not
managed through a separate EAC contract.

| Contract | Address |
|---|---|
| ETHRegistry | `0x1d78834d97c1d7b1a38c1dedbd1a287cfed3971e` |
| ETHRegistrar | `0x7d1b7f586a62ac3f54b9a396849757814283270b` |
| PublicResolverV2 | `0xf9de4979ddb290baf5b760d0e788125017bc33f6` |
| UpgradableUniversalResolverProxy | `0xd26f2040d083af1cd2962ba303f4bea0c4faf142` |
| VerifiableFactory | `0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780` |
| UserRegistryImpl | `0x47b442d0cf617c41cabaff5f02f44dd1e5f72546` |
| PermissionedResolverImpl | `0xa9d3814ab151bf6e37a427432795371a8361614e` |

Project-owned deployments:

| Contract | Where | Created by |
|---|---|---|
| UserRegistry proxy | `ENS_AGENT_REGISTRY_ADDRESS` | `setup-agent-namespace.js` (Verifiable Factory) |
| AgentSubnameRegistrar | `ENS_AGENT_REGISTRAR_ADDRESS` | `setup-agent-namespace.js` (plain deploy) |
| Per-agent Permissioned Resolver proxy | per controller | `register-single-agent.js` / frontend / simulator |

## Sponsor tracks this targets

- **ENS — Best Use of ENSv2** ($4,500): agents as ENSv2 subnames under a
  project-owned subname registry (`AgentSubnameRegistrar` over a
  Verifiable-Factory UserRegistry), each with its own Permissioned Resolver
  and non-transferable identity, plus a live Enhanced Access Control
  delegation — CreditBureau is allowed to write exactly one text record
  (spend limit) into the agent's name and does so on every limit change.
- **World — AgentKit** ($3,500): human-backing verification gating the Sybil-resistance score bonus.
- **The Graph — Best AI Tooling/Use Case** ($5,000): live, explainable credit-line recommendations computed from indexed agent history, exposed to AI agents through a purpose-built MCP server (`integrations/mcp`) and recipes that show agents when/why/how to query the subgraph.
- **Hedera — Tokenization of Anything** ($6,000): agent receivables tokenized via Asset Tokenization Studio, priced off the credit score.
- **Bazantic** ($3,000): the credit bureau as a recipe — an agent-facing manual for the The Graph + Hedera workflow (`integrations/bazantic`) with an LLM comparison harness that proves the recipe improves task success.
- *(Stretch)* **Ledger — AI Agents x Ledger** ($3,500): device-backed spend-limit enforcement instead of/alongside EAC.

See `docs/architecture.md` and `docs/demo-script.md` for the full story and the day-of-demo walkthrough.
