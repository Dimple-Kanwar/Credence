# Credence backend

One HTTP service for the server-owned integrations. It keeps Graph API keys, AgentKit credentials, deployer keys, and Hedera operator credentials out of the browser.

## Structure

- `server.js` starts the HTTP process.
- `routes.js` maps HTTP methods and paths to capabilities.
- `config.js` owns backend environment configuration.
- `utils/http.js` owns JSON parsing, CORS, and response formatting.
- `services/mcp.js` delegates reports, rankings, factoring, chat, and AgentKit-gated reports to the MCP integration.
- `services/world.js` delegates AgentBook, AgentKit, Selfie Check, and human-backing flows to World integrations.
- `services/hedera.js` delegates ATS lifecycle, x402, Mirror Node status, and Hedera operations to Hedera integrations.

The backend is an adapter layer: business rules remain in `integrations/`, while HTTP concerns remain under `backend/`.

## Start

From the repository root:

```bash
node backend/server.js
```

The default address is `http://127.0.0.1:8787`.

Required environment depends on the route:

- `GRAPH_ENDPOINT` or `VITE_SUBGRAPH_URL` for reports, rankings, factoring, and chat.
- `SEPOLIA_RPC_URL` and `CREDIT_BUREAU_ADDRESS` for ENS name resolution and World verification.
- `DEPLOYER_PRIVATE_KEY` plus AgentKit configuration for `/api/world/verify`.
- Hedera and ATS credentials for `/api/receivables/tokenize`.

## Routes

- `GET /api/health`
- `POST /api/report` with `{ "controller": "0x..." }` or an ENS name
- `POST /api/agents` with optional `{ "first": 25 }`
- `POST /api/factoring` with `{ "controller": "0x...", "faceValueUsd": 1000 }`
- `POST /api/chat` with `{ "message": "show the top agents" }`
- `POST /api/world/verify` with `{ "controller": "0x..." }`
- `POST /api/receivables/tokenize` with `{ "controller": "0x...", "faceValueUsd": 1000, "maturityDays": 30 }`
- `GET /credit-report/:controller` x402-paid report service
- `GET /factoring-rate/:controller` x402-paid factoring quote
- `GET /credit-report/health` x402 service health

Registration and settlement remain wallet-signed operations because the connected user must approve those transactions. The backend can be extended with transaction-creation endpoints, but it should not hold user wallet keys for those flows.

The Hedera x402 routes are served by this same process. `integrations/hedera/x402/server.js` remains only as a compatibility wrapper for older demos; it is not needed when `npm run backend` is running.
