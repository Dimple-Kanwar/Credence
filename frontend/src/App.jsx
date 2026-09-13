import { useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { request, gql } from "graphql-request";
import { discountRateForScore } from "./credit.js";
import { createAgentkitClient, declareAgentkitExtension } from "@worldcoin/agentkit";
import { IDKit, selfieCheckLegacy, IDKitErrorCodes } from "@worldcoin/idkit-core";
import QRCode from "qrcode";
import Sparkline from "./components/Sparkline.jsx";
import { Panel, SectionLabel, StatusPill } from "./components/ui.jsx";
import MCPChat from "./components/MCPChat.jsx";

const SEPOLIA_CHAIN_ID = 11155111n;
const RPC_URL = import.meta.env.VITE_RPC_URL || "https://ethereum-sepolia.publicnode.com";
// Project-specific addresses are intentionally NOT hard-coded (ENS track
// requirement: functional demo, no hard-coded values). Copy frontend/.env.example
// and fill these after deploying. Only ENS protocol constants fall back below.
const CREDIT_BUREAU_ADDRESS = import.meta.env.VITE_CREDIT_BUREAU_ADDRESS;
const ESCROW_ADDRESS = import.meta.env.VITE_ESCROW_ADDRESS;
const SUBGRAPH_URL = import.meta.env.VITE_SUBGRAPH_URL;
const ENS_ROOT_NAME = import.meta.env.VITE_ENS_ROOT_NAME || "agentcreditbureau.eth";
const ENS_REGISTRAR_ADDRESS = import.meta.env.VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS;
const ENS_FACTORY_ADDRESS =
  import.meta.env.VITE_ENS_VERIFIABLE_FACTORY || "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780";
const ENS_RESOLVER_IMPL =
  import.meta.env.VITE_ENS_PERMISSIONED_RESOLVER_IMPL || "0xa9d3814ab151bf6e37a427432795371a8361614e";
// Optional: lets the in-browser analyst panel call an OpenAI-compatible model
// for the narrative leg. Prefer running integrations/graph/credit-analyst.js or
// the MCP server so the key stays server-side — the deterministic decision +
// evidence below never needs a key.
const AI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || "";
const AI_MODEL_URL = import.meta.env.VITE_AI_MODEL_URL || "https://api.openai.com/v1/chat/completions";
const AI_MODEL = import.meta.env.VITE_AI_MODEL || "gpt-4o-mini";
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:8787";
const MCP_CHAT_URL = import.meta.env.VITE_MCP_CHAT_URL || `${BACKEND_URL}/api/chat`;
const WORLD_VERIFY_URL = import.meta.env.VITE_WORLD_VERIFY_URL || `${BACKEND_URL}/api/world/verify`;
const WORLD_STATUS_URL = import.meta.env.VITE_WORLD_STATUS_URL || `${BACKEND_URL}/api/world/status`;
const WORLD_REGISTER_URL = import.meta.env.VITE_WORLD_REGISTER_URL || `${BACKEND_URL}/api/world/register`;
const WORLD_GATE_URL = import.meta.env.VITE_WORLD_GATE_URL || `${BACKEND_URL}/api/world/gate`;
const WORLD_SELFIE_SIGN_URL = import.meta.env.VITE_WORLD_SELFIE_SIGN_URL || `${BACKEND_URL}/api/world/selfie/sign`;
const WORLD_SELFIE_VERIFY_URL = import.meta.env.VITE_WORLD_SELFIE_VERIFY_URL || `${BACKEND_URL}/api/world/selfie/verify`;
// The Graph composition workspace (ETHOnline 2026 composable track): status +
// standardized intel + natural-language access to The Graph's Subgraph MCP,
// proxied through the Node backend so GRAPH_API_KEY stays server-side.
const GRAPH_STACK_URL = import.meta.env.VITE_GRAPH_STACK_URL || `${BACKEND_URL}/api/graph/stack`;
const GRAPH_INTEL_URL = import.meta.env.VITE_GRAPH_INTEL_URL || `${BACKEND_URL}/api/graph/intel`;
const GRAPH_ASK_URL = import.meta.env.VITE_GRAPH_ASK_URL || `${BACKEND_URL}/api/graph/ask`;
// World ID environment for this project — SANDBOX ONLY (never production).
// The backend labels every credential environment:"sandbox" + mock:true; this
// mirrors that so the UI badges sandbox registrations instead of implying a
// real World Chain registration.
const WORLD_ENV = import.meta.env.VITE_WORLD_ENVIRONMENT || "sandbox";

// World Chain (eip155:480) — the canonical chain AgentBook lives on. The
// agentkit header an agent signs in the browser binds this chain reference so
// the backend's SIWE verification resolves the signer against AgentBook; the
// signing wallet itself can stay on Sepolia (EIP-191 recovery is
// chain-independent). AgentBook is a protocol constant (canonical deployment),
// so it falls back here like the ENS protocol addresses above it.
const AGENT_CHAIN_ID = "eip155:480";
const AGENT_BOOK_ADDRESS =
  import.meta.env.VITE_WORLD_AGENTBOOK_ADDRESS || "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";
const AGENT_BOOK_EXPLORER = `https://worldscan.org/address/${AGENT_BOOK_ADDRESS}`;

const SPEND_LIMIT_TEXT_KEY = "com.agentcreditbureau.spend-limit-wei";

const CREDIT_BUREAU_ABI = [
  "function getProfile(address controller) external view returns (tuple(string ensName, address controller, bool humanBacked, bool registered, bool frozen, uint32 score, uint256 spendLimitWei, uint32 totalTx, uint32 successTx, uint32 lateTx, uint32 disputedTx, uint32 defaultTx))",
  "function resolveByEnsName(string ensName) external view returns (address)",
  "function registerAgent(string ensName, bool humanBacked) external",
];

const ESCROW_ABI = ["function settleJob(bytes32 jobId, address payable payee) external payable"];
const FACTORY_ABI = [
  "function deployProxy(address implementation, uint256 salt, bytes data) external returns (address proxy)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
];
const RESOLVER_INIT_ABI = ["function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)"];
// Latest ENSv2 Permissioned Resolver: no authorizeTextRoles(). Argument-scoped
// roles are granted via grantSetterRoles(setter, account), where setter is ABI-
// encoded calldata whose selector+argument define the role. Setters take the
// DNS-encoded name (bytes), not a bytes32 node.
const RESOLVER_ABI = [
  "function grantSetterRoles(bytes setter, address account) external",
  // Included only to ABI-encode setter calldata for grantSetterRoles().
  "function setText(bytes name, string key, string value) external",
];
const REGISTRAR_ABI = [
  "function register(string label, address controller, address resolver, bool humanBacked, uint64 duration) external returns (uint256 tokenId)",
  "function labelOf(address controller) external view returns (string)",
];

// Same query shape the Graph credit analyst (integrations/graph/credit-analyst.js)
// and the MCP "get_agent_report" tool issue against the subgraph.
const AGENT_HISTORY_QUERY = gql`
  query AgentHistory($id: ID!) {
    agent(id: $id) {
      ensName
      score
      spendLimitWei
      humanBacked
      frozen
      totalTx
      successTx
      lateTx
      disputedTx
      defaultTx
      outcomes(orderBy: timestamp, orderDirection: desc, first: 20) {
        outcomeType
        amountWei
        timestamp
      }
      scoreHistory(orderBy: timestamp, orderDirection: desc, first: 12) {
        oldScore
        newScore
        timestamp
      }
      spendLimitChanges(orderBy: timestamp, orderDirection: desc, first: 12) {
        oldLimitWei
        newLimitWei
        timestamp
      }
    }
  }
`;

// Exact query behind the MCP "list_agents" tool.
const LIST_AGENTS_QUERY = gql`
  query ListAgents($first: Int!) {
    agents(orderBy: score, orderDirection: desc, first: $first) {
      id
      ensName
      score
      humanBacked
      frozen
      totalTx
      defaultTx
      spendLimitWei
      updatedAt
    }
  }
`;

// ---------------------------------------------------------------------------
// Pure logic kept in sync with the CLI/MCP integrations
// (integrations/graph/credit-analyst.js and integrations/mcp/server.js).
// ---------------------------------------------------------------------------

function scoreTier(score) {
  if (score >= 900) return "Prime";
  if (score >= 800) return "Established";
  if (score >= 650) return "Building";
  if (score >= 500) return "New";
  return "Restricted";
}

function formatUsd(value) {
  return Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ---------------------------------------------------------------------------
// Hedera payment outputs — structured result cards. One shared card shape for
// every step (pay-for-report, quote, issue, transfer, schedule, redeem) so the
// raw backend payload is presented as labeled metrics / rows + tx evidence.
// ---------------------------------------------------------------------------
function hashscanLink(txId) {
  if (!txId) return null;
  const match = String(txId).match(/(\d{1,10}\.\d{1,9})$/);
  return match ? `https://hashscan.io/testnet/transaction/${match[1]}` : null;
}

// HashScan's /transaction deep link resolves by CONSENSUS timestamp, but tx ids
// (0.0.x@<validStart>) carry the SIGNED/validStart time — usually a few seconds
// earlier than consensus, so linking validStart 404s. Resolve the consensus
// timestamp from the public testnet Mirror Node (CORS: *) and cache per tx id.
const consensusCache = new Map();

async function resolveConsensusTimestamp(txId) {
  if (!txId) return null;
  const key = String(txId);
  if (consensusCache.has(key)) return consensusCache.get(key);
  const dash = key.replace("@", "-").replace(/\.(\d+)$/, "-$1"); // 0.0.x-s-n
  let consensus = null;
  try {
    const res = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/transactions/${encodeURIComponent(dash)}`,
    );
    if (res.ok) {
      const data = await res.json();
      consensus = data?.transactions?.[0]?.consensus_timestamp || null;
    }
  } catch {
    consensus = null;
  }
  consensusCache.set(key, consensus);
  return consensus;
}

function HashScanLink({ txId, children, className = "" }) {
  const [consensus, setConsensus] = useState(null);
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setResolved(false);
    if (!txId) { setConsensus(null); setResolved(true); return undefined; }
    resolveConsensusTimestamp(txId).then((c) => {
      if (cancelled) return;
      setConsensus(c);
      setResolved(true);
    });
    return () => { cancelled = true; };
  }, [txId]);
  // Best effort while resolving / on mirror failure: link the tx-id timestamp
  // (identical to the previous behaviour rather than showing nothing).
  const href = consensus
    ? `https://hashscan.io/testnet/transaction/${consensus}`
    : hashscanLink(txId) || "#";
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children || (resolved && !consensus ? "HashScan ↪" : "…")}
    </a>
  );
}

function CopyButton({ text, label = "value" }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`copy-button${copied ? " copied" : ""}`}
      title={`Copy ${label} to clipboard`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(String(text ?? ""));
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? "✓ copied" : "⧉ copy"}
    </button>
  );
}

function TxEvidence({ txId, label = "settlement tx" }) {
  if (!txId) return null;
  return (
    <div className="tx-evidence">
      <span className="tx-evidence-label">{label}</span>
      <code className="tx-evidence-id" title={txId}>{txId}</code>
      <HashScanLink className="tx-evidence-link" txId={txId}>HashScan ↪</HashScanLink>
      <CopyButton text={txId} label={label} />
    </div>
  );
}

function Metric({ label, value, sub, accent }) {
  return (
    <div className="factoring-metric">
      <span className="metric-label">{label}</span>
      <span className={`metric-value${accent ? " accent" : ""}`}>
        {value}
        {sub ? <em>{sub}</em> : null}
      </span>
    </div>
  );
}

function DetailRow({ label, value, copy, href }) {
  const val = value === null || value === undefined || value === "" ? "—" : value;
  return (
    <div className="tx-row">
      <span className="tx-row-label">{label}</span>
      <span className="tx-row-value">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">{val} ↪</a>
        ) : copy ? (
          <>
            <code>{val}</code>
            <CopyButton text={val} label={label} />
          </>
        ) : (
          val
        )}
      </span>
    </div>
  );
}

function HederaOutcome({ badge, tone = "ok", title, agent, body, metrics = [], rows = [], tx, foot }) {
  return (
    <div className={`tx-card${tone === "warn" ? " warn" : ""}`}>
      <div className="tx-card-head">
        <span className={`factoring-badge ${tone === "warn" ? "warn" : "ok"}`}>{badge}</span>
        <span className="tx-card-title">{title}</span>
      </div>
      {agent && (
        <div className="tx-card-agent">
          <span className="factoring-quote-ens">{agent.ens || agent.controller}</span>
          {agent.controller && agent.ens && (
            <span className="factoring-quote-controller">{agent.controller}</span>
          )}
        </div>
      )}
      {body}
      {metrics.length > 0 && (
        <div className="tx-card-metrics">
          {metrics.map((m, i) => <Metric key={i} {...m} />)}
        </div>
      )}
      {rows.length > 0 && (
        <div className="tx-card-rows">
          {rows.map((r, i) => <DetailRow key={i} {...r} />)}
        </div>
      )}
      {tx && <TxEvidence txId={tx.txId} label={tx.label} />}
      {foot}
    </div>
  );
}

// Deterministic evidence-backed recommendation, mirroring
// integrations/graph/credit-analyst.js recommendationFor().
function recommendationFor(agent) {
  const total = Number(agent.totalTx || 0);
  const cleanRate = total === 0 ? 0 : Number(agent.successTx || 0) / total;
  const recentDefaults = (agent.outcomes || []).filter((o) => o.outcomeType === "Default").length;
  let recommendedLimitWei = BigInt(agent.spendLimitWei || 0);
  let decision = "review";

  if (agent.frozen || recentDefaults > 0 || Number(agent.defaultTx || 0) > 0) {
    recommendedLimitWei = 0n;
    decision = "decline";
  } else if (agent.humanBacked && Number(agent.score) >= 800 && cleanRate >= 0.9) {
    recommendedLimitWei *= 2n;
    decision = "approve";
  } else if (Number(agent.score) >= 650 && cleanRate >= 0.75) {
    decision = "approve-with-monitoring";
  }

  return {
    decision,
    recommendedLimitWei: recommendedLimitWei.toString(),
    cleanRate,
    evidence: [
      `Score ${agent.score}/1000 (${scoreTier(Number(agent.score))})`,
      `${agent.successTx}/${agent.totalTx} successful outcomes (${(cleanRate * 100).toFixed(0)}% clean)`,
      agent.humanBacked ? "World-backed identity signal present" : "No human-backing signal",
      agent.frozen ? "Agent is frozen" : "Agent is active",
    ],
  };
}

// Optional narrative leg — only fires when VITE_OPENAI_API_KEY is set in
// frontend/.env. The deterministic recommendation stands alone without it.
async function narrativeFor(agent, recommendation) {
  if (!AI_API_KEY) return null;
  const response = await fetch(AI_MODEL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${AI_API_KEY}` },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.1,
      messages: [
        { role: "system", content: "You are an underwriting analyst. Use only the supplied on-chain evidence. Never invent facts." },
        { role: "user", content: JSON.stringify({ agent, recommendation }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`AI model request failed: ${response.status}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || null;
}

// The exact payload the MCP "get_agent_report" tool returns to an AI agent
// (mirrors integrations/mcp/server.js summarizeReport()).
function summarizeReport(agent, recommendation, narrative, controller) {
  return {
    ensName: agent.ensName,
    controller: controller ?? null,
    score: agent.score,
    tier: scoreTier(Number(agent.score)),
    humanBacked: agent.humanBacked,
    frozen: agent.frozen,
    totalTx: agent.totalTx,
    successTx: agent.successTx,
    lateTx: agent.lateTx,
    disputedTx: agent.disputedTx,
    defaultTx: agent.defaultTx,
    spendLimitWei: agent.spendLimitWei,
    latestOutcomes: (agent.outcomes || []).slice(0, 10).map((o) => ({
      outcomeType: o.outcomeType,
      amountWei: o.amountWei,
      timestamp: o.timestamp,
    })),
    recentScoreHistory: (agent.scoreHistory || []).slice(0, 5),
    recommendation: {
      decision: recommendation.decision,
      recommendedLimitWei: recommendation.recommendedLimitWei,
      cleanRate: Number(recommendation.cleanRate.toFixed(4)),
      evidence: recommendation.evidence,
    },
    narrative: narrative || null,
  };
}

function messageFor(error) {
  return error?.shortMessage || error?.reason || error?.message || "Transaction failed.";
}

function isAddress(value) {
  return ethers.isAddress(value.trim());
}

function dnsEncode(name) {
  return ethers.concat([
    ...name.split(".").map((label) => {
      const bytes = ethers.toUtf8Bytes(label);
      return ethers.concat([Uint8Array.of(bytes.length), bytes]);
    }),
    Uint8Array.of(0),
  ]);
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

export default function App() {
  const [addressInput, setAddressInput] = useState("");
  const [profile, setProfile] = useState(null);
  const [history, setHistory] = useState([]);
  const [scoreHistory, setScoreHistory] = useState([]);
  const [limitChanges, setLimitChanges] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [narrative, setNarrative] = useState(null);
  const [wallet, setWallet] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletEnsName, setWalletEnsName] = useState("");
  const [walletNetwork, setWalletNetwork] = useState("");
  const [registerForm, setRegisterForm] = useState({ label: "agent1", humanBacked: true });
  const [worldLabel, setWorldLabel] = useState("agent1");
  const [settleForm, setSettleForm] = useState({ payee: "", amount: "0.001", job: "invoice-001" });
  const [factoringForm, setFactoringForm] = useState({ faceValueUsd: "1000" });
  const [leaderboard, setLeaderboard] = useState(null);
  const [mcpPayload, setMcpPayload] = useState(null);
  const [factoring, setFactoring] = useState(null);
  // Graph composition workspace: standardized intel + official Subgraph MCP + stack health
  const [graphStack, setGraphStack] = useState(null);
  const [graphIntel, setGraphIntel] = useState(null);
  const [graphAsk, setGraphAsk] = useState(null);
  const [graphStackLoading, setGraphStackLoading] = useState(false);
  const [graphIntelLoading, setGraphIntelLoading] = useState(false);
  const [graphAskLoading, setGraphAskLoading] = useState(false);
  const [graphAskPrompt, setGraphAskPrompt] = useState("discover the top subgraphs for the loaded agent");
  const [graphIntelError, setGraphIntelError] = useState(null);
  const [graphAskError, setGraphAskError] = useState(null);
  // Hedera workspace (frontend-driven demo): x402 paid services + ATS lifecycle
  const [hederaStatus, setHederaStatus] = useState(null); // { operatorConfigured, atsConfigured, payer, x402Server, facilitator }
  const [hederaBusy, setHederaBusy] = useState("");
  const [hederaController, setHederaController] = useState("");
  const [hederaForm, setHederaForm] = useState({
    faceValueUsd: "1000",
    maturityDays: "30",
    tokenAddress: "",
    lpAccount: "",
    units: "100000",
    mode: "contract",
    executeAt: "",
  });
  const [x402Payment, setX402Payment] = useState(null);
  const [hederaQuote, setHederaQuote] = useState(null);
  const [hederaIssue, setHederaIssue] = useState(null);
  const [hederaTransfer, setHederaTransfer] = useState(null);
  const [hederaSchedule, setHederaSchedule] = useState(null);
  const [hederaRedeem, setHederaRedeem] = useState(null);
  const [hederaEvidence, setHederaEvidence] = useState([]);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(false);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [activePage, setActivePage] = useState("overview");
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", content: "Ask me for a credit report, agent ranking, or factoring rate from The Graph." },
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const [worldVerifying, setWorldVerifying] = useState(false);
  const [worldVerifyResult, setWorldVerifyResult] = useState(null); // { kind: "ok" | "error", message, at } — shown below the Verify World button
  const [registerResult, setRegisterResult] = useState(null); // { kind: "ok" | "error", message, at } — shown below the Register identity button
  const [worldStatus, setWorldStatus] = useState(null); // { registered, humanId, address } from AgentBook
  const [worldGate, setWorldGate] = useState(null); // bot-vs-human gate result
  const [worldChecking, setWorldChecking] = useState(false);
  const [worldGateRunning, setWorldGateRunning] = useState(false);
  const [worldGateMode, setWorldGateMode] = useState(null); // "human" | "bot" — which gate probe last ran
  const worldCheckingRef = useRef(false);
  // World Selfie Check (medium-assurance liveness credential) state
  const [selfieStatus, setSelfieStatus] = useState(null); // { verified, verifiedAt, environment, action, nullifierShort } from status
  const [selfiePhase, setSelfiePhase] = useState("idle"); // idle | signing | awaiting | verifying | done | failed
  const [selfieConnector, setSelfieConnector] = useState({ uri: "", hint: "" });
  const [selfieQrDataUrl, setSelfieQrDataUrl] = useState("");
  const [selfieMessage, setSelfieMessage] = useState("");
  const selfieRequestRef = useRef(null);

  const readProvider = new ethers.JsonRpcProvider(RPC_URL);
  const configured = (v) => Boolean(v && !String(v).includes("<") && !String(v).includes("..."));

  function networkLabel(network) {
    if (network.chainId === SEPOLIA_CHAIN_ID) return "Sepolia";
    return network.name && network.name !== "unknown" ? network.name : `Chain ${network.chainId.toString()}`;
  }

  useEffect(() => {
    if (!window.ethereum) return undefined;
    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const refreshNetwork = async () => {
      try {
        setWalletNetwork(networkLabel(await browserProvider.getNetwork()));
      } catch {
        setWalletNetwork("");
      }
    };
    window.ethereum.on?.("chainChanged", refreshNetwork);
    return () => window.ethereum.removeListener?.("chainChanged", refreshNetwork);
  }, []);

  async function connectWallet() {
    setError(null);
    if (!window.ethereum) {
      setError("Install a browser wallet such as MetaMask to send transactions.");
      return;
    }
    try {
      const browserProvider = new ethers.BrowserProvider(window.ethereum);
      const network = await browserProvider.getNetwork();
      if (network.chainId !== SEPOLIA_CHAIN_ID) {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] });
      }
      const connectedNetwork = await browserProvider.getNetwork();
      const signer = await browserProvider.getSigner();
      const address = await signer.getAddress();
      setWallet(signer);
      setWalletAddress(address);
      setWalletEnsName("");
      setWalletNetwork(networkLabel(connectedNetwork));
      setSettleForm((current) => ({ ...current, payee: current.payee || address }));
      // Show the wallet's ENS name in the right upper corner (header) as soon
      // as it resolves. Two sources:
      //   1. CreditBureau.getProfile — when the wallet is a registered agent.
      //   2. AgentSubnameRegistrar.labelOf(address) — fallback for any wallet
      //      that owns an agent subname but isn't yet pinned to the bureau
      //      (e.g. right after `register-single-agent.js` mints the name).
      let resolvedEnsName = "";
      if (CREDIT_BUREAU_ADDRESS) {
        try {
          const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, readProvider);
          const profile = await bureau.getProfile(address);
          if (profile.registered && profile.ensName) resolvedEnsName = profile.ensName;
        } catch (profileErr) {
          console.warn("Could not resolve ENS identity for the connected wallet:", profileErr);
        }
      }
      if (!resolvedEnsName && ENS_REGISTRAR_ADDRESS) {
        try {
          const registrar = new ethers.Contract(ENS_REGISTRAR_ADDRESS, REGISTRAR_ABI, readProvider);
          const label = await registrar.labelOf(address);
          if (label) resolvedEnsName = `${label}.${ENS_ROOT_NAME}`;
        } catch (labelErr) {
          console.warn("No registrar-level ENS label resolved for the connected wallet:", labelErr);
        }
      }
      if (resolvedEnsName) setWalletEnsName(resolvedEnsName);
      // setNotice("Wallet connected on Sepolia.");
    } catch (err) {
      setError(messageFor(err));
    }
  }

  // Fetch the on-chain profile + the full subgraph report, then run the
  // analyst locally for the evidence-backed recommendation.
  async function loadAgent(input) {
    if (!CREDIT_BUREAU_ADDRESS) {
      throw new Error("CreditBureau is not configured. Set VITE_CREDIT_BUREAU_ADDRESS in frontend/.env.");
    }
    let controller = input.trim();
    if (!isAddress(controller)) {
      const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, readProvider);
      controller = await bureau.resolveByEnsName(controller);
      if (controller === ethers.ZeroAddress) throw new Error("No controller is registered for that ENS name.");
    }
    const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, readProvider);
    const onchain = await bureau.getProfile(controller);
    if (!onchain.registered) throw new Error("No agent registered at this address.");

    let graphAgent = null;
    if (SUBGRAPH_URL) {
      try {
        const data = await request(SUBGRAPH_URL, AGENT_HISTORY_QUERY, { id: controller.toLowerCase() });
        graphAgent = data.agent;
        setHistory(graphAgent?.outcomes ?? []);
        setScoreHistory(graphAgent?.scoreHistory ?? []);
        console.log("Subgraph scoreHistory:", graphAgent?.scoreHistory ?? []);
        setLimitChanges(graphAgent?.spendLimitChanges ?? []);
      } catch (subgraphErr) {
        // Subgraph is optional for the on-chain read to still work in a demo.
        console.warn("Subgraph query failed, falling back to on-chain-only view:", subgraphErr);
      }
    }
    // Ensure at least the on-chain numbers drive the analyst.
    const agentForAnalysis = graphAgent
      ? {
          ensName: graphAgent.ensName || onchain.ensName,
          score: graphAgent.score ?? Number(onchain.score),
          humanBacked: graphAgent.humanBacked ?? onchain.humanBacked,
          frozen: graphAgent.frozen ?? onchain.frozen,
          totalTx: graphAgent.totalTx ?? Number(onchain.totalTx),
          successTx: graphAgent.successTx ?? Number(onchain.successTx),
          lateTx: graphAgent.lateTx ?? Number(onchain.lateTx),
          disputedTx: graphAgent.disputedTx ?? Number(onchain.disputedTx),
          defaultTx: graphAgent.defaultTx ?? Number(onchain.defaultTx),
          spendLimitWei: graphAgent.spendLimitWei ?? onchain.spendLimitWei.toString(),
          outcomes: graphAgent.outcomes ?? [],
          scoreHistory: graphAgent.scoreHistory ?? [],
          spendLimitChanges: graphAgent.spendLimitChanges ?? [],
        }
      : {
          ensName: onchain.ensName,
          score: Number(onchain.score),
          humanBacked: onchain.humanBacked,
          frozen: onchain.frozen,
          totalTx: Number(onchain.totalTx),
          successTx: Number(onchain.successTx),
          lateTx: Number(onchain.lateTx),
          disputedTx: Number(onchain.disputedTx),
          defaultTx: Number(onchain.defaultTx),
          spendLimitWei: onchain.spendLimitWei.toString(),
          outcomes: [],
          scoreHistory: [],
          spendLimitChanges: [],
        };

    const rec = recommendationFor(agentForAnalysis);
    setAnalysis(rec);
    setNarrative(null);
    try {
      setNarrative(await narrativeFor(agentForAnalysis, rec));
    } catch (narrErr) {
      console.warn("Narrative leg failed (deterministic recommendation is unaffected):", narrErr);
    }
    setProfile(onchain);
    return controller;
  }

  async function lookupAgent() {
    setError(null);
    setLoading(true);
    setProfile(null);
    setHistory([]);
    setAnalysis(null);
    setMcpPayload(null);
    setFactoring(null);
    try {
      const controller = await loadAgent(addressInput);
      setAddressInput(controller);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setLoading(false);
    }
  }

  async function lookupAgentFor(controller) {
    try {
      await loadAgent(controller);
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function registerAgent() {
    setRegisterResult(null);
    if (!wallet)
      return setRegisterResult({ kind: "error", message: "Connect a Sepolia wallet first.", at: new Date().toISOString() });
    if (!CREDIT_BUREAU_ADDRESS)
      return setRegisterResult({
        kind: "error",
        message: "CreditBureau is not configured. Set VITE_CREDIT_BUREAU_ADDRESS in frontend/.env.",
        at: new Date().toISOString(),
      });
    if (!ENS_REGISTRAR_ADDRESS)
      return setRegisterResult({
        kind: "error",
        message: "ENS registrar is not configured. Set VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS in frontend/.env.",
        at: new Date().toISOString(),
      });
    const label = registerForm.label.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,32}$/.test(label))
      return setRegisterResult({ kind: "error", message: "Use a label with 3-32 lowercase letters, numbers, or hyphens.", at: new Date().toISOString() });
    setAction("register");
    try {
      const controller = await wallet.getAddress();

      // World leg (REGISTRATION FIRST per docs.world.org agent-kit step 2):
      // register this controller in the World AgentBook BEFORE any ENS
      // contract is called. This project uses the World ID SANDBOX
      // (WORLD_ID_ENVIRONMENT=staging on the backend), so a successful
      // registration is a clearly-labeled sandbox credential
      // (`mock: true, environment: "sandbox"`) — still sufficient to mint
      // humanBacked=true. A failed registration mints humanBacked=false and
      // can be upgraded later via the Verify World page / /api/world/verify.
      let humanBacked = false;
      let humanId = null;
      let worldEnv = WORLD_ENV;
      let worldMock = false;
      if (WORLD_REGISTER_URL) {
        try {
          const worldResponse = await fetch(WORLD_REGISTER_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ address: controller }),
          });
          const worldPayload = await worldResponse.json().catch(() => ({}));
          if (worldResponse.ok && worldPayload.registered) {
            humanBacked = true;
            humanId = worldPayload.humanId || null;
            worldEnv = worldPayload.environment || (worldPayload.mock ? "sandbox" : WORLD_ENV);
            worldMock = Boolean(worldPayload.mock);
            console.log(
              `World AgentBook registration ${worldMock ? `(${worldEnv}) ` : ""}— human ${humanId} backs ${controller}.`
            );
          } else {
            console.warn(
              "World AgentBook registration did not succeed — minting with humanBacked=false.",
              worldPayload.error || worldPayload.verifyUrl || ""
            );
          }
        } catch (worldErr) {
          console.warn("World AgentBook registration unavailable during mint:", worldErr);
        }
      }

      const factory = new ethers.Contract(ENS_FACTORY_ADDRESS, FACTORY_ABI, wallet);
      const salt = BigInt(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "address", "uint256"],
            [ethers.keccak256(ethers.toUtf8Bytes("OwnedResolver")), controller, 0n]
          )
        )
      );
      const initData = new ethers.Interface(RESOLVER_INIT_ABI).encodeFunctionData("initialize", [
        [{ account: controller, roleBitmap: BigInt("0x" + "1".repeat(64)) }],
        [],
      ]);
      const deployTx = await factory.deployProxy(ENS_RESOLVER_IMPL, salt, initData);
      const deployReceipt = await deployTx.wait();
      const factoryInterface = new ethers.Interface(FACTORY_ABI);
      const deployed = deployReceipt.logs
        .map((log) => {
          try {
            return factoryInterface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((event) => event?.name === "ProxyDeployed");
      if (!deployed) throw new Error("ENS resolver deployment event was not found.");
      const resolver = deployed.args.proxyAddress;

      const registrar = new ethers.Contract(ENS_REGISTRAR_ADDRESS, REGISTRAR_ABI, wallet);
      const duration = 365n * 24n * 60n * 60n;
      await (await registrar.register(label, controller, resolver, humanBacked, duration)).wait();

      const resolverContract = new ethers.Contract(resolver, RESOLVER_ABI, wallet);
      const setterCalldata = resolverContract.interface.encodeFunctionData("setText", [
        dnsEncode(`${label}.${ENS_ROOT_NAME}`),
        SPEND_LIMIT_TEXT_KEY,
        "",
      ]);
      await (await resolverContract.grantSetterRoles(setterCalldata, CREDIT_BUREAU_ADDRESS)).wait();

      // Persist the World identity as part of the ENS identity: the controller
      // wallet holds ALL_ROLES on its own Permissioned Resolver, so it can
      // write the world.agentbook.* records itself (no extra EAC grant needed).
      // This makes the resolvable ENS name itself carry the World credential.
      if (humanBacked && humanId) {
        const worldRecords = [
          ["world.agentbook.human-id", humanId],
          ["world.agentbook.backed", "true"],
          ["world.agentbook.lookup", worldMock ? "sandbox://credence-sandbox-agentbook" : "worldchain-agentbook"],
          ["world.agentbook.environment", worldEnv],
          ["world.agentbook.mock", worldMock ? "true" : "false"],
          ["world.agentbook.timestamp", new Date().toISOString()],
        ];
        for (const [key, value] of worldRecords) {
          try {
            await (await resolverContract.setText(dnsEncode(`${label}.${ENS_ROOT_NAME}`), key, value)).wait();
          } catch (recordErr) {
            console.warn(`Could not write ENS record ${key}:`, recordErr);
          }
        }
        console.log(`World identity (${worldEnv}${worldMock ? "/mock" : ""}) written to ENS records of ${label}.${ENS_ROOT_NAME}.`);
      }

      const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, wallet);
      await (await bureau.registerAgent(`${label}.${ENS_ROOT_NAME}`, humanBacked)).wait();

      setWalletEnsName(`${label}.${ENS_ROOT_NAME}`);
      setAddressInput(controller);
      setRegisterResult({
        kind: "ok",
        message: `${label}.${ENS_ROOT_NAME} registered (${humanBacked ? "World human-backed ✓" + (worldMock ? ` · ${worldEnv} credential` : "") : "bot-only — no AgentBook proof"}). Loading its live report…`,
        at: new Date().toISOString(),
      });
      await loadAgent(controller).catch((loadErr) =>
        console.warn("Report refresh skipped after registration:", loadErr)
      );
    } catch (err) {
      setRegisterResult({ kind: "error", message: messageFor(err), at: new Date().toISOString() });
    } finally {
      setAction("");
    }
  }

  async function settleJob() {
    setError(null);
    setNotice(null);
    if (!wallet) return setError("Connect a Sepolia wallet first.");
    if (!ESCROW_ADDRESS) return setError("Escrow is not configured. Set VITE_ESCROW_ADDRESS in frontend/.env.");
    if (!isAddress(settleForm.payee)) return setError("Enter a valid payee address.");
    setAction("settle");
    try {
      const jobId = ethers.keccak256(ethers.toUtf8Bytes(settleForm.job.trim() || `${Date.now()}`));
      const escrow = new ethers.Contract(ESCROW_ADDRESS, ESCROW_ABI, wallet);
      const tx = await escrow.settleJob(jobId, settleForm.payee, { value: ethers.parseEther(settleForm.amount) });
      await tx.wait();
      setNotice(`Settlement confirmed: ${tx.hash.slice(0, 10)}…`);
      await lookupAgentFor(await wallet.getAddress());
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setAction("");
    }
  }

  // ------------------------------------------------------------------
  // The Graph MCP capabilities, run live in the browser. Each button runs
  // exactly the query the MCP server tool would run, so the JSON shown is
  // the payload an MCP client (Claude/Cursor/agent SDK) receives.
  // ------------------------------------------------------------------

  async function runListAgents() {
    setError(null);
    setLeaderboardLoading(true);
    setLeaderboard(null);
    if (!SUBGRAPH_URL) {
      setLeaderboardLoading(false);
      return setError("Subgraph is not configured. Set VITE_SUBGRAPH_URL in frontend/.env.");
    }
    try {
      const data = await request(SUBGRAPH_URL, LIST_AGENTS_QUERY, { first: 25 });
      setLeaderboard(data.agents ?? []);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setLeaderboardLoading(false);
    }
  }

  async function runGetAgentReport() {
    setError(null);
    setMcpPayload(null);
    if (!profile) return setError("Pull a report first — get_agent_report needs a controller or ENS name.");
    if (!SUBGRAPH_URL) return setError("Subgraph is not configured. Set VITE_SUBGRAPH_URL in frontend/.env.");
    try {
      const data = await request(SUBGRAPH_URL, AGENT_HISTORY_QUERY, { id: profile.controller.toLowerCase() });
      const agent = {
        ensName: data.agent?.ensName || profile.ensName,
        score: data.agent?.score ?? Number(profile.score),
        spendLimitWei: data.agent?.spendLimitWei ?? profile.spendLimitWei.toString(),
        humanBacked: data.agent?.humanBacked ?? profile.humanBacked,
        frozen: data.agent?.frozen ?? profile.frozen,
        totalTx: data.agent?.totalTx ?? Number(profile.totalTx),
        successTx: data.agent?.successTx ?? Number(profile.successTx),
        lateTx: data.agent?.lateTx ?? Number(profile.lateTx),
        disputedTx: data.agent?.disputedTx ?? Number(profile.disputedTx),
        defaultTx: data.agent?.defaultTx ?? Number(profile.defaultTx),
        outcomes: data.agent?.outcomes ?? [],
        scoreHistory: data.agent?.scoreHistory ?? [],
        spendLimitChanges: data.agent?.spendLimitChanges ?? [],
      };
      const rec = recommendationFor(agent);
      const narr = await narrativeFor(agent, rec);
      setMcpPayload(JSON.stringify(summarizeReport(agent, rec, narr, profile.controller), null, 2));
      setNarrative(narr);
    } catch (err) {
      setError(messageFor(err));
    }
  }

  async function runGetFactoringRate() {
    setError(null);
    setFactoring(null);
    if (!profile) return setError("Pull a report first — get_factoring_rate needs a controller or ENS name.");
    if (!SUBGRAPH_URL) return setError("Subgraph is not configured. Set VITE_SUBGRAPH_URL in frontend/.env.");
    try {
      const data = await request(SUBGRAPH_URL, AGENT_HISTORY_QUERY, { id: profile.controller.toLowerCase() });
      const agent = data.agent || {};
      const score = Number(agent.score ?? profile.score);
      const frozen = agent.frozen ?? profile.frozen;
      const faceValueUsd = Number(factoringForm.faceValueUsd || 0);
      const discountRate = discountRateForScore(score);
      const eligible = !frozen && discountRate !== null;
      setFactoring({
        controller: profile.controller,
        ensName: agent.ensName || profile.ensName,
        score,
        eligible,
        frozen,
        discountRate: eligible ? discountRate : null,
        discountPercent: eligible ? discountRate * 100 : null,
        faceValueUsd: faceValueUsd > 0 ? faceValueUsd : null,
        pricedSaleUsd: eligible && faceValueUsd > 0 ? Number((faceValueUsd * (1 - discountRate)).toFixed(2)) : null,
        note: eligible
          ? "Tokenize via integrations/hedera/scripts/tokenize-receivable.js on Hedera testnet."
          : frozen
            ? "Agent is FROZEN — receivables are not eligible for factoring."
            : "Score below the 500 factoring threshold.",
      });
    } catch (err) {
      setError(messageFor(err));
    }
  }

  // -------------------------------------------------------------------------
  // Graph composition (ETHOnline 2026 The Graph composable/standardized
  // track): cross-protocol intel via Messari standardized subgraphs + the
  // official hosted Subgraph MCP + the live stack status. Proxied through the
  // Node backend so GRAPH_API_KEY never lives in the browser.
  // -------------------------------------------------------------------------
  async function getGraph(path, body) {
    if (!BACKEND_URL) throw new Error("Set VITE_BACKEND_URL (the Node backend that proxies Graph requests).");
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Graph ${path} failed: HTTP ${response.status}`);
    return payload;
  }

  async function loadGraphStack(force = false) {
    if (graphStack && !force) return;
    setGraphStackLoading(true);
    try {
      setGraphStack(await getGraph("/api/graph/stack"));
    } catch (err) {
      setGraphStack({ error: messageFor(err) });
    } finally {
      setGraphStackLoading(false);
    }
  }

  async function runGraphIntel() {
    setGraphIntelError(null);
    setGraphIntel(null);
    if (!profile) return setGraphIntelError("Load an agent report first — market intel is contextualized to the loaded agent.");
    setGraphIntelLoading(true);
    try {
      setGraphIntel(await getGraph("/api/graph/intel", { controller: profile.controller }));
    } catch (err) {
      setGraphIntelError(messageFor(err));
    } finally {
      setGraphIntelLoading(false);
    }
  }

  async function runGraphAsk() {
    setGraphAskError(null);
    const prompt = graphAskPrompt.trim();
    if (!prompt) return setGraphAskError("Enter a question for The Graph Network first.");
    setGraphAskLoading(true);
    try {
      // Pass the loaded agent's controller so discovery presets can search by
      // contract address without the user typing one.
      setGraphAsk(await getGraph("/api/graph/ask", { prompt, controller: profile?.controller || null }));
    } catch (err) {
      setGraphAskError(messageFor(err));
    } finally {
      setGraphAskLoading(false);
    }
  }

  // Refresh the stack panel each time the Graph workspace opens.
  useEffect(() => {
    if (activePage === "graph") loadGraphStack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage]);

  // -------------------------------------------------------------------------
  // Hedera: x402 paid services + ATS receivable lifecycle — everything the
  // demo needs is driven from this page, proxied through the Node backend so
  // Hedera keys never live in the browser.
  // -------------------------------------------------------------------------
  function hashscanTxLink(txId) {
    return hashscanLink(txId);
  }
  async function postHedera(path, body) {
    if (!BACKEND_URL) throw new Error("Set VITE_BACKEND_URL (the Node backend that holds the Hedera keys).");
    const response = await fetch(`${BACKEND_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    console.log(`POST ${path} returned HTTP ${response.status}`);
    const payload = await response.json().catch(() => ({}));
    console.log(`POST ${path} payload:`, payload);
    if (!response.ok) throw new Error(payload.error || `Hedera ${path} failed: HTTP ${response.status}`);
    return payload;
  }
  async function refreshHederaStatus() {
    try {
      const response = await fetch(`${BACKEND_URL}/api/hedera/status`);
      if (response.ok) setHederaStatus(await response.json());
    } catch { /* backend offline */ }
  }
  function pushEvidence(kind, result) {
    const txId = result?.transactionId || result?.scheduleTxId || result?.payment?.transactionId || result?.scheduleId;
    setHederaEvidence((cur) =>
      [{ kind, at: new Date().toISOString(), txId: txId || null, summary: JSON.stringify(result) }, ...cur].slice(0, 10),
    );
  }
  async function hederaPay(service) {
    setError(null);
    setX402Payment(null);
    if (!hederaController) return setError("Enter a controller (address or ENS name) first.");
    setHederaBusy(service);
    try {
      const path = service === "rate" ? "/api/hedera/x402/rate" : "/api/hedera/x402/report";
      console.log(`Calling ${path} for controller ${hederaController}…`);
      const r = await postHedera(path, { controller: hederaController });
      setX402Payment({ ...r, _service: service });
      pushEvidence(`x402:${service}`, r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  async function hederaQuotePrice() {
    setError(null);
    setHederaQuote(null);
    if (!hederaController) return setError("Enter a controller (address or ENS name) first.");
    setHederaBusy("quote");
    try {
      const r = await postHedera("/api/hedera/quote", {
        controller: hederaController,
        faceValueUsd: hederaForm.faceValueUsd,
      });
      setHederaQuote(r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  async function hederaDoIssue() {
    setError(null);
    setHederaIssue(null);
    if (!hederaController) return setError("Enter a controller (address or ENS name) first.");
    setHederaBusy("issue");
    try {
      const r = await postHedera("/api/receivables/tokenize", {
        controller: hederaController,
        faceValueUsd: hederaForm.faceValueUsd,
        maturityDays: hederaForm.maturityDays,
      });
      setHederaIssue(r);
      setHederaForm((f) => ({ ...f, tokenAddress: r.tokenAddress || f.tokenAddress }));
      pushEvidence("ats:issue", r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  async function hederaDoTransfer() {
    setError(null);
    setHederaTransfer(null);
    if (!hederaForm.tokenAddress || !hederaForm.lpAccount) return setError("Token address and LP account are required.");
    setHederaBusy("transfer");
    try {
      const r = await postHedera("/api/hedera/transfer", {
        tokenAddress: hederaForm.tokenAddress,
        lpAccount: hederaForm.lpAccount,
        units: hederaForm.units,
      });
      setHederaTransfer(r);
      pushEvidence("ats:transfer", r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  async function hederaDoSchedule() {
    setError(null);
    setHederaSchedule(null);
    if (!hederaForm.tokenAddress) return setError("Token address is required.");
    setHederaBusy("schedule");
    try {
      const r = await postHedera("/api/hedera/schedule", {
        tokenAddress: hederaForm.tokenAddress,
        lpAccount: hederaForm.lpAccount,
        units: hederaForm.units,
        mode: hederaForm.mode,
        executeAtUnixSeconds: hederaForm.executeAt ? Number(hederaForm.executeAt) : undefined,
      });
      setHederaSchedule(r);
      pushEvidence("ats:schedule", r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  async function hederaDoRedeem() {
    setError(null);
    setHederaRedeem(null);
    if (!hederaForm.tokenAddress || !hederaForm.lpAccount) return setError("Token address and holder (LP) account are required.");
    setHederaBusy("redeem");
    try {
      const r = await postHedera("/api/hedera/redeem", {
        tokenAddress: hederaForm.tokenAddress,
        holder: hederaForm.lpAccount,
        units: hederaForm.units,
      });
      setHederaRedeem(r);
      pushEvidence("ats:redeem", r);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setHederaBusy("");
    }
  }
  useEffect(() => {
    refreshHederaStatus();
  }, []);

  async function askMcpChat(question) {
    const text = question.trim();
    if (!text) return;
    setChatMessages((current) => [...current, { role: "user", content: text }]);
    setChatLoading(true);
    try {
      if (MCP_CHAT_URL) {
        const response = await fetch(MCP_CHAT_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, history: chatMessages }),
        });
        if (!response.ok) throw new Error(`MCP bridge failed: ${response.status}`);
        const payload = await response.json();
        const result = payload.result || payload.text || payload.message || payload;
        setChatMessages((current) => [...current, { role: "assistant", content: typeof result === "string" ? result : JSON.stringify(result, null, 2) }]);
        return;
      }

      const address = text.match(/0x[a-fA-F0-9]{40}/)?.[0];
      const ensName = text.match(/[a-z0-9-]+\.agentcreditbureau\.eth/i)?.[0];
      const subject = address || ensName;
      if (/list|rank|top|leaderboard/i.test(text)) {
        await runListAgents();
        setChatMessages((current) => [...current, { role: "assistant", content: "I ran `list_agents` against the configured Graph subgraph. The ranked results are available in the Graph tools tab." }]);
      } else if (/factor|invoice|receivable|discount/i.test(text) && subject) {
        if (address || ensName) setAddressInput(subject);
        setChatMessages((current) => [...current, { role: "assistant", content: "Use the Graph tools tab to price this receivable, or pull its report first for the complete evidence trail." }]);
        setActivePage("graph");
      } else if (subject) {
        setAddressInput(subject);
        await loadAgent(subject);
        setActivePage("report");
        setChatMessages((current) => [...current, { role: "assistant", content: `I pulled the Graph-backed report for ${subject}. Open the Report tab to inspect the score and recommendation.` }]);
      } else {
        setChatMessages((current) => [...current, { role: "assistant", content: "I can query `get_agent_report`, `get_factoring_rate`, or `list_agents`. Include a controller address or ENS name for an agent-specific request." }]);
      }
    } catch (err) {
      setChatMessages((current) => [...current, { role: "assistant", content: messageFor(err) }]);
    } finally {
      setChatLoading(false);
    }
  }

  async function verifyWorldIdentity() {
    setWorldVerifyResult(null);
    const label = worldLabel.trim().toLowerCase();
    const ensName = `${label}.${ENS_ROOT_NAME}`;
    if (!/^[a-z0-9-]{3,32}$/.test(label)) {
      setWorldVerifyResult({ kind: "error", message: "Use a label with 3-32 lowercase letters, numbers, or hyphens.", at: new Date().toISOString() });
      return;
    }

    setWorldVerifying(true);
    try {
      const response = await fetch(WORLD_VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controller: ensName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `World verification failed: ${response.status}`);
      setWorldVerifyResult({ kind: "ok", message: payload.message || `World human backing confirmed for ${ensName}.`, at: new Date().toISOString() });
      await checkWorldStatus(ensName, { silent: true });
      await loadAgent(ensName).catch((loadErr) =>
        console.warn("Report refresh skipped after World verification (agent not yet registered with the bureau):", loadErr)
      );
    } catch (err) {
      const detail = err instanceof TypeError
        ? `Could not reach the Credence backend at ${WORLD_VERIFY_URL}. Start it with npm run backend and check VITE_BACKEND_URL.`
        : messageFor(err);
      setWorldVerifyResult({ kind: "error", message: detail, at: new Date().toISOString() });
    } finally {
      setWorldVerifying(false);
    }
  }

  // Live AgentBook credential check for a controller (the "real credentials"
  // read — no checkbox: the flag comes from World Chain's canonical AgentBook).
  // `silent` suppresses the page-level error banner so the 20s auto-refresh on
  // the Verify World page doesn't spam errors while the backend is starting.
  async function checkWorldStatus(candidate, opts = {}) {
    if (!opts.silent) setError(null);
    worldCheckingRef.current = true;
    setWorldChecking(true);
    try {
      const input = candidate || worldCandidate();
      if (!input) {
        setWorldStatus(null);
        return null;
      }
      const response = await fetch(WORLD_STATUS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: input }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `World status check failed: ${response.status}`);
      setWorldStatus({ ...payload, checkedAt: new Date().toISOString(), addressChecked: input });
      // Selfie Check credential (medium-assurance) rides along on the same
      // live status read — it is an independent signal from the AgentBook
      // AgentKit registration above.
      if (payload.selfieCheck) setSelfieStatus({ ...payload.selfieCheck, addressChecked: input });
      return payload;
    } catch (err) {
      setWorldStatus(null);
      if (!opts.silent) {
        const detail = err instanceof TypeError
          ? `Could not reach the Credence backend at ${WORLD_STATUS_URL}. Start it with npm run backend and check VITE_BACKEND_URL.`
          : messageFor(err);
        setError(detail);
      }
      return null;
    } finally {
      worldCheckingRef.current = false;
      setWorldChecking(false);
    }
  }

  // Resolve what the Verify World page should be checking right now: the
  // connected wallet first, then the loaded report address/ENS name, then the
  // label being verified (sent as a full ENS name).
  function worldCandidate() {
    if (walletAddress) return walletAddress;
    const input = (addressInput || "").trim();
    if (input) return input;
    const label = (worldLabel || "").trim();
    return label ? `${label}.${ENS_ROOT_NAME}` : null;
  }

  // Sign a real `agentkit` header in the browser with the connected wallet —
  // the same flow integrations/world/agent-client.js runs server-side, but
  // with the wallet (MetaMask) as the signer instead of a private key. No
  // chain switch needed: the header binds the eip155:480 chain reference for
  // the backend's SIWE verification, and EIP-191 signatures verify by address
  // recovery no matter which network the wallet is currently on.
  //
  // declareAgentkitExtension() leaves nonce/issuedAt out (the SDK's server
  // extension mints them), but viem's SIWE requires them and the backend caps
  // freshness at 5 minutes — so we attach a fresh claim before signing.
  async function makeAgentkitHeader(resourceUri, statement) {
    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner(walletAddress);
    const issuedAt = new Date();
    const nonceBytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(nonceBytes);
    const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const declarations = declareAgentkitExtension({
      domain: new URL(resourceUri).hostname,
      resourceUri,
      statement: statement || "Credence: prove this agent is backed by a unique real human",
      network: AGENT_CHAIN_ID,
      mode: { type: "free" },
    });
    const agentkit = declarations.agentkit;
    agentkit.info = {
      ...agentkit.info,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expirationTime: new Date(issuedAt.getTime() + 300_000).toISOString(),
    };
    const client = createAgentkitClient({
      signer: {
        address: walletAddress,
        chainId: AGENT_CHAIN_ID,
        type: "eip191",
        signMessage: (message) => signer.signMessage(message),
      },
    });
    return client.createHeader(agentkit);
  }

  // Bot-vs-human gate demo. mode "human": sign a live agentkit header with the
  // connected wallet and present it — the backend verifies the SIWE signature
  // and resolves the signer in AgentBook; access is granted only if a real
  // human backs the wallet. mode "bot": send no header at all — the backend
  // must deny the call (a headless bot has no human to sign for it).
  async function runWorldGate(mode = "human") {
    setError(null);
    setNotice(null);
    setWorldGate(null);
    setWorldGateMode(mode);
    if (mode === "human" && !wallet) return setError("Connect a wallet first — the gate signs the agentkit header with it.");
    setWorldGateRunning(true);
    try {
      let agentkitHeader = null;
      if (mode === "human") {
        agentkitHeader = await makeAgentkitHeader(WORLD_GATE_URL, "Credence credit-report gate");
      }
      const response = await fetch(WORLD_GATE_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentkitHeader, controller: walletAddress || null, resourceUri: WORLD_GATE_URL }),
      });
      const payload = await response.json().catch(() => ({}));
      setWorldGate({ mode, http: response.status, ...payload, checkedAt: new Date().toISOString() });
      // A granted gate proves the connected wallet is backed by a human —
      // refresh the live status card for it right away.
      if (payload.allowed && walletAddress) await checkWorldStatus(walletAddress, { silent: true });
    } catch (err) {
      const detail = err instanceof TypeError
        ? `Could not reach the Credence backend at ${WORLD_GATE_URL}. Start it with npm run backend.`
        : messageFor(err);
      setError(detail);
    } finally {
      setWorldGateRunning(false);
    }
  }

  // ------------------------------------------------------------------
  // World Selfie Check — medium-assurance liveness credential (prize track)
  // ------------------------------------------------------------------

  // The proof signal must be a plain controller identifier we can also bind on
  // the backend. Prefer the connected wallet address, then a pasted 0x address.
  function selfieSignal() {
    if (walletAddress) return walletAddress;
    const input = (addressInput || "").trim();
    return isAddress(input) ? input : null;
  }

  // Friendly copy for IDKit flow failures (mirrors @worldcoin/idkit-core
  // IDKitErrorCodes where it matters for this track).
  function selfieErrorFor(code) {
    const map = {
      [IDKitErrorCodes.UserRejected]: "Verification cancelled in the World App.",
      [IDKitErrorCodes.CredentialUnavailable]: "Selfie Check is not available for this app — request the Selfie Check feature flag from your World point of contact (the credential is access-gated Beta).",
      [IDKitErrorCodes.FeatureUnavailable]: "Selfie Check is not enabled for this app (access-gated Beta).",
      [IDKitErrorCodes.InvalidRpSignature]: "Request signature rejected — check WORLD_RP_SIGNING_KEY / WORLD_ID_APP_ID / WORLD_ID_RP_ID on the backend.",
      [IDKitErrorCodes.RpSignatureExpired]: "Request signature expired — re-run Selfie Check.",
      [IDKitErrorCodes.NullifierReplayed]: "This identity has already verified this action.",
      [IDKitErrorCodes.InclusionProofFailed]: "Proof generation failed inside the World App — try again.",
      [IDKitErrorCodes.ConnectionFailed]: "Could not reach the World App network.",
    };
    return map[code] || `World App flow failed (${code}).`;
  }

  // Step 1+2: RP-sign the request server-side, build the IDKit request with
  // the selfieCheckLegacy preset, render the connector URI (QR/deep link) and
  // poll the World App for the completed proof.
  async function startSelfieCheck() {
    setError(null);
    setNotice(null);
    const signal = selfieSignal();
    if (!signal) {
      return setError("Connect a wallet or enter a controller address — Selfie Check binds the proof to the agent controller.");
    }
    setSelfiePhase("signing");
    setSelfieMessage("Signing the Selfie Check request with your backend's RP key…");
    try {
      const signResponse = await fetch(WORLD_SELFIE_SIGN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ controller: signal }),
      });
      const cfg = await signResponse.json().catch(() => ({}));
      if (!signResponse.ok) throw new Error(cfg.error || `Selfie Check sign failed: ${signResponse.status}`);

      setSelfiePhase("awaiting");
      setSelfieMessage(
        `${cfg.connector_hint || (cfg.mock ? "DEMO MODE" : "Complete the check in the World App")} — scan the QR or tap the link to start the camera liveness check.`
      );

      const request = await IDKit.request({
        app_id: cfg.app_id,
        action: cfg.action,
        action_description: "Credence: prove a live human controls this agent wallet (Selfie Check)",
        rp_context: {
          rp_id: cfg.rp_id,
          nonce: cfg.nonce,
          created_at: cfg.created_at,
          expires_at: cfg.expires_at,
          signature: cfg.sig,
        },
        allow_legacy_proofs: true,
        environment: cfg.environment,
      }).preset(selfieCheckLegacy({ signal }));
      selfieRequestRef.current = request;
      setSelfieConnector({ uri: request.connectorURI, hint: cfg.connector_hint || "" });

      // Render the connector URI as a scannable QR code (desktop flow).
      try {
        const dataUrl = await QRCode.toDataURL(request.connectorURI, { width: 220, margin: 1, color: { dark: "#0c0f10", light: "#f4f0e8" } });
        setSelfieQrDataUrl(dataUrl);
      } catch {
        setSelfieQrDataUrl("");
      }

      const completion = await request.pollUntilCompletion({ pollInterval: 2_000, timeout: 600_000 });
      if (!completion.success) {
        setSelfiePhase("failed");
        setSelfieMessage(selfieErrorFor(completion.error));
        return;
      }

      // Step 4: forward the IDKit result to the backend for verification.
      setSelfiePhase("verifying");
      setSelfieMessage("Proof received — verifying with the World ID Developer Portal…");
      const verifyResponse = await fetch(WORLD_SELFIE_VERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          controller: signal,
          rp_id: cfg.rp_id,
          ensName: worldLabel.trim() ? `${worldLabel.trim().toLowerCase()}.${ENS_ROOT_NAME}` : undefined,
          idkitResponse: completion.result,
        }),
      });
      const verified = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) throw new Error(verified.error || `Selfie Check verification failed: ${verifyResponse.status}`);

      setSelfieStatus(verified);
      setSelfiePhase("done");
      setSelfieMessage(
        `${verified.mock ? "DEMO MODE — " : ""}Selfie Check verified — controller ${verified.controller} is backed by a live, returning human (${verified.environment}).` +
          (verified.txHash ? ` humanBacked flipped on-chain (${verified.txHash.slice(0, 10)}…).` : "") +
          (verified.records?.length ? ` ENS identity records written: ${verified.records.length}.` : "") +
          (verified.mock ? " This is a simulated credential — switch WORLD_ID_MOCK off once the Selfie Check feature flag is enabled." : "")
      );
      setNotice(
        verified.mock
          ? `Selfie Check credential recorded in demo mode (${verified.controller}).`
          : `Selfie Check credential recorded for ${verified.controller}.`
      );
      await checkWorldStatus(signal, { silent: true });
      await loadAgent(signal);
    } catch (err) {
      setSelfiePhase("failed");
      setSelfieMessage(
        err instanceof TypeError
          ? `Could not reach the Credence backend at ${WORLD_SELFIE_SIGN_URL}. Start it with npm run backend.`
          : messageFor(err)
      );
    }
  }

  function cancelSelfieCheck() {
    selfieRequestRef.current = null;
    setSelfiePhase("idle");
    setSelfieMessage("");
    setSelfieQrDataUrl("");
    setSelfieConnector({ uri: "", hint: "" });
  }

  // While the Verify World page is open the AgentBook credential check stays
  // live: refresh the status card 20s after the last check, and re-run
  // immediately when the page opens or the connected wallet/input changes.
  useEffect(() => {
    if (activePage !== "world") return undefined;
    const run = async () => {
      if (worldCheckingRef.current) return;
      const candidate = worldCandidate();
      if (candidate) await checkWorldStatus(candidate, { silent: true });
    };
    run();
    const timer = setInterval(run, 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage, walletAddress, worldLabel, addressInput]);

  const discount = profile ? discountRateForScore(Number(profile.score)) : null;
  const decisionLabel = {
    approve: "APPROVE",
    "approve-with-monitoring": "APPROVE · MONITOR",
    review: "REVIEW",
    decline: "DECLINE",
  };
  // Only trust the cached AgentBook status for the register panel when it
  // actually refers to the connected wallet (live checks on the Verify World
  // page may target a different controller/ENS name).
  const walletStatusMatches =
    worldStatus && walletAddress && worldStatus.address?.toLowerCase() === walletAddress.toLowerCase();
  const worldCandidateLabel = worldCandidate() || "—";
  const configItems = [
    { label: "Bureau", value: CREDIT_BUREAU_ADDRESS },
    { label: "Escrow", value: ESCROW_ADDRESS },
    { label: "Registrar", value: ENS_REGISTRAR_ADDRESS },
    { label: "Subgraph", value: SUBGRAPH_URL },
    { label: "Hedera", value: hederaStatus?.operatorConfigured ? (hederaStatus.operatorId || "set") : null },
    { label: "x402", value: hederaStatus?.x402Server?.ok ? "live" : null },
  ];

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <span className="wordmark">Credence</span>
          <span className="subhead">credit infrastructure for autonomous agents</span>
        </div>
        <button className="wallet-button" onClick={connectWallet}>
          {walletAddress ? (
            <>
              <span className="wallet-network">{walletNetwork || "Connected"}</span>
              {walletEnsName && <span className="wallet-ens" title={`ENSv2 identity: ${walletEnsName}`}>{walletEnsName}</span>}
              {walletEnsName && WORLD_ENV !== "production" && (
                <span className="env-tag" title="World ID sandbox — this identity is backed by a clearly-labeled sandbox credential, never production World IDs.">SANDBOX</span>
              )}
              <span>{`${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`}</span>
            </>
          ) : "Connect wallet"}
        </button>
      </header>

      <nav className="workspace-nav" aria-label="Credence workspace">
        {[
          ["overview", "Overview"],
          ["report", "Reports"],
          ["register", "Register agent"],
          ["settle", "Settlement"],
          ["world", "Verify World"],
          ["hedera", "Hedera payments"],
          ["graph", "Graph tools"],
        ].map(([page, label]) => (
          <button key={page} className={activePage === page ? "active" : ""} onClick={() => setActivePage(page)}>
            {label}
          </button>
        ))}
        <button className="chat-nav-button" onClick={() => setActivePage("chat")}>Open MCP chat <span>↗</span></button>
      </nav>

      {/* Live configuration strip — every address is env-driven, never baked in. */}
      <section className="config-strip">
        <SectionLabel>LIVE CONFIG</SectionLabel>
        {configItems.map((item) => (
          <div key={item.label} className={`config-item ${configured(item.value) ? "ok" : "warn"}`}>
            {item.label} {configured(item.value) ? shortAddr(item.value) : "not set"}
          </div>
        ))}
        <div className="config-item ok">ENS root {ENS_ROOT_NAME}</div>
      </section>

      {activePage === "overview" && <section className="intro">
        <p className="kicker">THE TRUST LAYER FOR MACHINE ECONOMIES</p>
        <h1>
          Every agent has a
          <br />
          <em>ledger of consequences.</em>
        </h1>
        <p className="lede">
          ENSv2 identity, human backing, a credit line enforced at the moment money moves — indexed by The
          Graph, priced by AI, tradable on Hedera, and readable by any AI agent over MCP.
        </p>
      </section>}

      {activePage === "report" && <section className="lookup">
        <input
          className="lookup-input"
          placeholder="agent controller address (0x…) or ENS name"
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && lookupAgent()}
        />
        <button className="lookup-button" onClick={lookupAgent} disabled={loading || !addressInput}>
          {loading ? "Querying…" : "Pull report"}
        </button>
      </section>}

      {error && <p className="error">{error}</p>}©
      {notice && <p className="notice">{notice}</p>}

      {(activePage === "register" || activePage === "settle") && <div className="action-grid">
        {activePage === "register" && <section className="action-panel">
          <span className="panel-index">01 / IDENTITY · ENSv2 + WORLD</span>
          <h2>Mint an agent identity</h2>
          <p>
            Deploy a permissioned ENSv2 resolver proxy, mint a subname under {ENS_ROOT_NAME}, scope
            ROLE_SET_TEXT to the bureau, and pin the first credit report.
          </p>
          <div className="form-row">
            <input
              value={registerForm.label}
              onChange={(e) => setRegisterForm({ ...registerForm, label: e.target.value })}
              aria-label="ENS label"
            />
            <span className="suffix">.{ENS_ROOT_NAME}</span>
          </div>
          <div className="world-backing">
            <span className="world-backing-label">World AgentBook credential</span>
            {walletAddress ? (
              walletStatusMatches ? (
                <span className={`world-backing-value ${worldStatus.registered ? "ok" : "warn"}`}>
                  {worldStatus.registered
                    ? `✓ human-backed (id ${(worldStatus.humanId || "").slice(0, 12)}…)`
                        + (worldStatus.environment === "sandbox" || worldStatus.mock ? " · sandbox" : "")
                    : "✗ not registered — bot-only"}
                </span>
              ) : worldChecking ? (
                <span className="world-backing-value">checking World AgentBook…</span>
              ) : (
                <button className="link-button" onClick={() => checkWorldStatus(walletAddress)}>
                  check AgentBook status
                </button>
              )
            ) : (
              <span className="world-backing-value warn">connect wallet to verify</span>
            )}
            <em className="world-backing-hint">
              humanBacked is derived from the World AgentBook registration.
            </em>
          </div>
          <button className="action-button" onClick={registerAgent} disabled={action === "register"}>
            {action === "register" ? "Waiting for wallet…" : "Register identity"}
          </button>
          {registerResult && (
            <div className={`gate-banner ${registerResult.kind === "ok" ? "granted" : "denied"}`}>
              <strong>
                {registerResult.kind === "ok" ? "✓ IDENTITY MINTED" : "✗ IDENTITY MINT FAILED"}
              </strong>
              <span className="status-meta">{registerResult.message}</span>
            </div>
          )}
        </section>}

        {activePage === "settle" && <section className="action-panel">
          <span className="panel-index">02 / SETTLEMENT · CREDIT ESCROW</span>
          <h2>Run a credit-limited job</h2>
          <p>
            CreditEscrow checks the connected agent's spend limit before forwarding payment and records a
            clean outcome through its reporter role.
          </p>
          <div className="form-row">
            <input
              value={settleForm.amount}
              onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })}
              inputMode="decimal"
              aria-label="Amount in ETH"
            />
            <span className="suffix">ETH</span>
          </div>
          <input
            className="full-input"
            value={settleForm.payee}
            onChange={(e) => setSettleForm({ ...settleForm, payee: e.target.value })}
            placeholder="payee address"
            aria-label="Payee address"
          />
          <input
            className="full-input"
            value={settleForm.job}
            onChange={(e) => setSettleForm({ ...settleForm, job: e.target.value })}
            placeholder="job reference"
            aria-label="Job reference"
          />
          <button className="action-button secondary" onClick={settleJob} disabled={action === "settle"}>
            {action === "settle" ? "Settling…" : "Settle through escrow"}
          </button>
          <p className="script-hint">on-chain: CreditEscrow.settleJob() enforces isCreditworthy()</p>
        </section>}
      </div>
      }

      {activePage === "world" && <section className="workflow-page world-page">
        <div className="page-heading"><SectionLabel>WORLD AGENTKIT · HUMAN BACKING</SectionLabel><h1>Verify the human behind an agent.</h1><p>World proof adds a unique-human signal to the credit bureau. The maintained verification script checks AgentKit, then writes the result to CreditBureau.</p></div>

        {/* Live AgentBook status — auto-refreshing credential check */}
        <Panel>
          <div className="panel-head-row">
            <h2>Live AgentBook status</h2>
            <span className={`live-tag ${worldStatus ? (worldStatus.registered ? "live" : "idle") : "off"}`}>
              <i className="live-dot" />
              {worldChecking ? "CHECKING" : worldStatus ? (worldStatus.registered ? "LIVE · HUMAN-BACKED" : "LIVE · BOT-ONLY") : "OFF"}
            </span>
          </div>
          <p className="mcp-tool-desc">
            Resolves the candidate wallet against the <strong>World AgentBook</strong> — on the World ID <strong>SANDBOX </strong>
             for this project. Refreshes every 20s while this page is open.
          </p>
          <div className="world-candidate">
            <span>checking</span>
            <code>{worldCandidateLabel}</code>
            {worldStatus?.checkedAt && <span className="status-meta">updated {new Date(worldStatus.checkedAt).toLocaleTimeString()}</span>}
          </div>
          {worldStatus ? (
            <div className={`world-status ${worldStatus.registered ? "ok" : "warn"}`}>
              <strong>{worldStatus.registered ? "✓ REGISTERED IN AGENTBOOK" : "✗ NOT IN AGENTBOOK"}</strong>
              <dl>
                <div><dt>Controller</dt><dd className="mono">{worldStatus.address}</dd></div>
                {worldStatus.humanId && <div><dt>Human ID</dt><dd className="mono">{worldStatus.humanId}</dd></div>}
                <div><dt>Registry</dt><dd>{(worldStatus.environment === "sandbox" || worldStatus.mock) ? `AgentBook · World ID sandbox (${worldStatus.registry || "credence-sandbox-agentbook"})` : `AgentBook · World Chain (eip155:480)`}</dd></div>
                <div><dt>Environment</dt><dd className="mono">{worldStatus.environment || (WORLD_ENV !== "production" ? "sandbox" : "production")}</dd></div>
                <div><dt>Last checked</dt><dd className="mono">{new Date(worldStatus.checkedAt).toLocaleString()}</dd></div>
              </dl>
              <p className={`world-verdict ${worldStatus.registered ? "ok" : "warn"}`}>
                {worldStatus.registered
                  ? "This wallet is registered in the World AgentBook — the bureau's humanBacked flag resolves to TRUE and the credit score carries the Sybil-resistance premium."
                  : "No human backs this wallet — the bureau treats it as a bot-only agent (humanBacked FALSE), with the score impact that implies."}
              </p>
            
            </div>
          ) : worldChecking ? (
            <p className="empty">Checking World Chain AgentBook…</p>
          ) : (
            <p className="empty">No live check yet — connect a wallet, pull a report, or enter an agent label below.</p>
          )}
          <div className="action-row">
            <button className="action-button secondary" onClick={() => checkWorldStatus(worldCandidate())} disabled={worldChecking || !worldCandidate()}>
              {worldChecking ? "Checking AgentBook…" : "Check now"}
            </button>
            {walletAddress && (
              <button className="link-button" onClick={() => checkWorldStatus(walletAddress)}>check my connected wallet</button>
            )}
          </div>
        </Panel>

        {/* World Selfie Check — medium-assurance liveness credential (prize track) */}
        <Panel>
          <div className="panel-head-row">
            <h2>Selfie Check — live person behind the agent</h2>
            <span className={`live-tag ${selfieStatus?.verified ? "live" : "off"}`}>
              <i className="live-dot" />
              {selfieStatus?.verified ? (selfieStatus.mock ? "DEMO CREDENTIAL ACTIVE" : "CREDENTIAL ACTIVE") : "NOT VERIFIED"}
            </span>
          </div>
          <p className="mcp-tool-desc">
            World <strong>Selfie Check</strong> is a low-friction, medium-assurance biometric credential: the device
            camera runs liveness + facial-similarity checks (no Orb required). Credence treats it as an
            <strong> abuse-prevention, continuity and eligibility signal</strong> — a fresh camera check by a real,
            returning human is required to flip the agent's <code>humanBacked</code> flag. The RP signing key stays
            on your backend; only the proof payload moves through the browser.
          </p>

          {selfiePhase === "idle" && !selfieStatus?.verified && (
            <div className="selfie-steps">
              <span>01</span><strong>Sign request server-side (RP key)</strong>
              <span>02</span><strong>Complete liveness in World App via QR / deep link</strong>
              <span>03</span><strong>Verify proof & flip humanBacked + ENS records</strong>
            </div>
          )}

          {selfieStatus?.verified && (
            <div className="world-status ok">
              <strong>✓ SELFIE CHECK PASSED</strong>
              <dl>
                <div><dt>Controller</dt><dd className="mono">{worldStatus?.address || selfieSignal() || "—"}</dd></div>
                <div><dt>Human continuity</dt><dd>unique action-scoped nullifier (one human per agent)</dd></div>
                <div><dt>Verified at</dt><dd className="mono">{new Date(selfieStatus.verifiedAt).toLocaleString()}</dd></div>
                <div><dt>Environment</dt><dd className="mono">{selfieStatus.environment}</dd></div>
              </dl>
              <p className={`world-verdict ${selfieStatus.mock ? "warn" : "ok"}`}>
                {selfieStatus.mock
                  ? "DEMO MODE — this credential is simulated (WORLD_ID_MOCK=1), so a real Selfie Check proof is not attached. Remove the mock flag once the Selfie Check feature flag is enabled for your app."
                  : "Medium-assurance credential recorded — the bureau's humanBacked flag is TRUE with Selfie Check provenance (world.selfiecheck.* ENS records), distinct from the high-assurance AgentBook signal above."}
              </p>
            </div>
          )}

          {(selfiePhase === "awaiting" || selfiePhase === "signing" || selfiePhase === "verifying") && (
            <div className="selfie-await">
              <div className="qr-box">
                {selfieQrDataUrl ? (
                  <img src={selfieQrDataUrl} width="220" height="220" alt="Selfie Check QR — scan with the World App" />
                ) : (
                  <div className="qr-placeholder">Connector URI pending…</div>
                )}
              </div>
              <div className="selfie-await-copy">
                <p className="mcp-tool-desc">{selfieMessage}</p>
                {selfieConnector.uri && (
                  <p className="status-meta">
                    deep link: <a className="world-link" href={selfieConnector.uri} target="_blank" rel="noreferrer">open in World App ↗</a>
                    {selfieConnector.hint && <span> · {selfieConnector.hint}</span>}
                  </p>
                )}
                <div className="action-row">
                  <button className="action-button secondary" onClick={cancelSelfieCheck}>Cancel</button>
                  {(selfiePhase === "awaiting" || selfiePhase === "verifying") && (
                    <span className="status-meta">waiting for World App…</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {selfiePhase === "failed" && (
            <div className="gate-banner denied">
              <strong>✗ SELFIE CHECK FAILED</strong>
              <span className="status-meta">{selfieMessage}</span>
            </div>
          )}

          {selfiePhase === "done" && (
            <div className="gate-banner granted">
              <strong>✓ SELFIE CHECK VERIFIED</strong>
              <span className="status-meta">{selfieMessage}</span>
            </div>
          )}

          <div className="action-row">
            <button
              className="action-button"
              onClick={startSelfieCheck}
              disabled={selfiePhase === "signing" || selfiePhase === "awaiting" || selfiePhase === "verifying" || !selfieSignal()}
            >
              {selfiePhase === "signing" ? "Signing request…" : selfiePhase === "verifying" ? "Verifying proof…" : "Start Selfie Check"}
            </button>
            {selfieStatus?.verified && (
              <button className="link-button" onClick={startSelfieCheck}>re-run (continuity check)</button>
            )}
            {!selfieSignal() && (
              <span className="status-meta">connect a wallet or enter a controller address to bind the proof</span>
            )}
          </div>
        </Panel>

        <Panel>
          <h2>Verification handoff</h2>
          <p className="mcp-tool-desc">Run the proof flow in World App and submit the confirmed controller to the server-side verifier. Private keys and AgentKit credentials stay out of the browser.</p>
          <div className="world-flow"><span>01</span><strong>Complete World ID proof</strong><span>02</span><strong>AgentKit confirms registration</strong><span>03</span><strong>CreditBureau records backing</strong></div>
          <div className="form-row">
            <input
              value={worldLabel}
              onChange={(event) => setWorldLabel(event.target.value)}
              placeholder="agent label"
              aria-label="ENS label for World verification"
            />
            <span className="suffix">.{ENS_ROOT_NAME}</span>
          </div>
          <button className="action-button" onClick={verifyWorldIdentity} disabled={worldVerifying}>
            {worldVerifying ? "Verifying with AgentKit…" : "Verify World identity"}
          </button>
          {worldVerifyResult && (
            <div className={`gate-banner ${worldVerifyResult.kind === "ok" ? "granted" : "denied"}`}>
              <strong>
                {worldVerifyResult.kind === "ok" ? "✓ WORLD IDENTITY VERIFIED" : "✗ WORLD VERIFICATION FAILED"}
              </strong>
              <span className="status-meta">{worldVerifyResult.message}</span>
            </div>
          )}
        </Panel>

        <Panel>
          <div className="panel-head-row">
            <h2>Bot vs human-backed agent gate</h2>
            {worldGate && (
              <span className={`live-tag ${worldGate.allowed ? "live" : "idle"}`}>
                <i className="live-dot" />
                {worldGate.allowed ? "ACCESS GRANTED" : "ACCESS DENIED"}
              </span>
            )}
          </div>
          <p className="mcp-tool-desc">The backend /api/world/gate verifies a signed agentkit header and resolves the signer to its human ID on World Chain. Bots (unregistered signers) are denied — the exact "distinguish a bot from a human-backed agent" use case.</p>
          <div className="gate-actions">
            <button className="action-button" onClick={() => runWorldGate("human")} disabled={worldGateRunning || !wallet}>
              {worldGateRunning && worldGateMode === "human" ? "Signing agentkit header…" : "Run gate as human-backed agent"}
            </button>
            <button className="action-button secondary" onClick={() => runWorldGate("bot")} disabled={worldGateRunning}>
              {worldGateRunning && worldGateMode === "bot" ? "Probing without header…" : "Run gate as a bot"}
            </button>
          </div>
          <p className="script-hint">
            Human path signs a live <code>agentkit</code> header with the connected wallet (your MetaMask gets a signature
            request) — the same wallet that must be registered in AgentBook for approval. The bot path sends no header:
            a headless bot has no human to sign for it, so the backend must deny it.
          </p>
          {worldGate && (
            <div className={`gate-banner ${worldGate.allowed ? "granted" : "denied"}`}>
              <strong>{worldGate.allowed ? "✓ ACCESS GRANTED — human-backed agent" : "✗ ACCESS DENIED — bot blocked"}</strong>
              <span className="status-meta">
                {worldGate.allowed
                  ? `human ${worldGate.humanId || ""} · signer ${worldGate.address || ""}`
                  : worldGate.error || "no signed agentkit header presented"}
              </span>
            </div>
          )}
          {worldGate && <pre className="mcp-json compact">{JSON.stringify(worldGate, null, 2)}</pre>}
        </Panel>
      </section>}

      {profile && activePage === "report" && (
        <main className="report">
          <div className="report-hero">
            <div className="score-block">
              <span className="score-number">{profile.score.toString()}</span>
              <span className="score-tier">{scoreTier(Number(profile.score))}</span>
            </div>
            <dl className="hero-facts">
              <div>
                <dt>Agent</dt>
                <dd>
                  {profile.ensName}{" "}
                  <a href={`https://sepolia.etherscan.io/address/${profile.controller}`} target="_blank" rel="noreferrer">
                    ↗
                  </a>
                </dd>
              </div>
              <div>
                <dt>Human-backed</dt>
                <dd>
                  {profile.humanBacked
                    ? selfieStatus?.verified && String(selfieStatus.controller || "").toLowerCase() === String(profile.controller).toLowerCase()
                      ? "Yes — Selfie Check (medium-assurance)"
                      : "Yes — World AgentKit"
                    : "No"}
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd className={profile.frozen ? "status-frozen" : "status-active"}>
                  {profile.frozen ? "Frozen" : "Active"}
                </dd>
              </div>
              <div>
                <dt>Spend limit</dt>
                <dd>{ethers.formatEther(profile.spendLimitWei)} ETH / window</dd>
              </div>
              <div>
                <dt>Track record</dt>
                <dd>
                  {profile.totalTx.toString()} tx · {profile.successTx.toString()} clean ·{" "}
                  {profile.defaultTx.toString()} default
                </dd>
              </div>
            </dl>
          </div>

          {/* Agent analysis — the Graph credit analyst, live in the browser */}
          <Panel>
            <h2>Agent analysis · evidence-backed decision (The Graph credit analyst)</h2>
            {analysis ? (
              <>
                <div className={`decision decision-${analysis.decision}`}>
                  {decisionLabel[analysis.decision] || analysis.decision}
                  <span className="decision-sub">
                    {analysis.decision === "decline"
                      ? "limit set to 0 — agent is not creditworthy"
                      : `recommended limit ${ethers.formatEther(BigInt(analysis.recommendedLimitWei))} ETH` +
                        (analysis.decision === "approve" ? " (×2 for human-backed Prime)" : "")}
                  </span>
                </div>
                <ul className="evidence">
                  {analysis.evidence.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                {narrative ? (
                  <blockquote className="narrative">
                    “{narrative}”
                    <cite>AI analyst · {AI_MODEL}</cite>
                  </blockquote>
                ) : (
                  <p className="narrative-empty">
                    The deterministic decision above uses only on-chain Graph data.
                  </p>
                )}
              </>
            ) : (
              <p className="empty">Pull a report to run the analyst.</p>
            )}
          </Panel>

          <Panel className="two-col">
            <div>
              <h2>Score history (subgraph ScoreUpdated events)</h2>
              <Sparkline data={scoreHistory} />
            </div>
            <div>
              <h2>Spend limit changes</h2>
              {limitChanges.length === 0 ? (
                <p className="empty">No limit changes indexed yet.</p>
              ) : (
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Limit</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {limitChanges.map((row, i) => (
                      <tr key={i}>
                        <td>{ethers.formatEther(row.newLimitWei)} ETH</td>
                        <td>{new Date(Number(row.timestamp) * 1000).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>

          <Panel>
            <h2>Receivables factoring rate · Hedera ATS</h2>
            {discount !== null ? (
              <p className="factoring-line">
                At this score, an outstanding invoice from this agent would tokenize on Hedera at a{" "}
                <strong>{(discount * 100).toFixed(0)}%</strong> discount to face value.
              </p>
            ) : (
              <p className="factoring-line factoring-ineligible">
                Score is below the factoring threshold — this agent's receivables are not currently eligible
                for tokenization.
              </p>
            )}
            {factoring && (
              <div className="factoring-result">
                <div>
                  eligibility: <strong>{factoring.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"}</strong>
                </div>
                {factoring.eligible && (
                  <>
                    <div>discount rate: <strong>{factoring.discountPercent}%</strong></div>
                    {factoring.faceValueUsd && (
                      <div>
                        ${Number(factoring.faceValueUsd).toLocaleString()} face value →{" "}
                        <strong>${factoring.pricedSaleUsd.toLocaleString()} sale price</strong>
                      </div>
                    )}
                  </>
                )}
                <div className="script-hint">{factoring.note}</div>
              </div>
            )}
          </Panel>

          <Panel>
            <h2>Hedera rails · agentic payments + receivables</h2>
            <p className="factoring-line">
              The same score that prices the receivable above also runs the agent's own payment rail:
              AI agents pay <strong>per credit call in HBAR</strong> via x402 (Blocky402 facilitator) — no API
              key, no seats — and the agent's invoices are issued, traded, and redeemed as ATS bonds.
            </p>
            <div className="cap-grid">
              <div className="cap-item">
                <h4>x402 pay-per-call (HBAR)</h4>
                <ul className="cap-list">
                  <li><code>/credit-report/:controller</code> — 100 tinybar</li>
                  <li><code>/factoring-rate/:controller</code> — 50 tinybar</li>
                  <li>settled via Blocky402 on testnet; server holds no key</li>
                  <li className="script-hint">node x402/buyer.js &lt;controller&gt; report</li>
                  <li className="script-hint">node x402/agent-demo.js &lt;controller&gt;</li>
                </ul>
              </div>
              <div className="cap-item">
                <h4>ATS receivable lifecycle</h4>
                <ul className="cap-list">
                  <li>issue: <code>npm run tokenize -- &lt;ctrl&gt; &lt;faceUsd&gt; &lt;days&gt;</code></li>
                  <li>price: <code>npm run quote -- &lt;ctrl&gt;</code> (score oracle)</li>
                  <li>sell: <code>npm run transfer -- &lt;token&gt; &lt;lp&gt; &lt;units&gt;</code></li>
                  <li>maturity: <code>npm run redeem / npm run schedule</code></li>
                </ul>
              </div>
            </div>
            <div className="script-hint">
              Facilitating: https://api.testnet.blocky402.com · ledger: https://hashscan.io/testnet
            </div>
          </Panel>

          <Panel>
            <h2>Recent ledger entries</h2>
            {history.length === 0 ? (
              <p className="empty">No indexed history yet — the subgraph may still be syncing.</p>
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Amount</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, i) => (
                    <tr key={i} className={`row-${row.outcomeType.toLowerCase()}`}>
                      <td>{row.outcomeType}</td>
                      <td>{ethers.formatEther(row.amountWei)} ETH</td>
                      <td>{new Date(Number(row.timestamp) * 1000).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </main>
      )}

      {/* The Graph × MCP — the same tools an AI agent calls over stdio, run here in the browser. */}
      {activePage === "hedera" && (
        <section className="mcp-section">
          <span className="panel-index">HEDERA · AGENTIC PAYMENTS + RECEIVABLES</span>
          <h2 className="mcp-title">Pay per credit call in HBAR, then factor the invoice on the same ledger</h2>
          <p className="mcp-lede">
            This page is the full Hedera loop, driven from the browser (via the Node backend that holds the
            Hedera keys): an agent <strong>pays 100 tinybar for a credit report</strong> through the Blocky402 x402
            facilitator, and the same score <strong>prices the tokenization of its receivable</strong> on ATS — issue,
            sell to an LP, and schedule the maturity settlement.
          </p>

          <div className="hedera-status-row">
            {hederaStatus ? (
              <>
                <StatusPill tone={hederaStatus.operatorConfigured ? "live" : "warn"}>
                  Hedera operator {hederaStatus.operatorConfigured ? "configured" : "placeholder"}
                </StatusPill>
                <StatusPill tone={hederaStatus.atsConfigured ? "live" : "warn"}>
                  ATS {hederaStatus.atsConfigured ? "configured" : "not configured"}
                </StatusPill>
                <StatusPill tone={hederaStatus.x402Server?.ok ? "live" : "warn"}>
                  x402 {hederaStatus.x402Server?.ok ? `live (${hederaStatus.x402Server.network})` : "server down"}
                </StatusPill>
                <StatusPill tone={hederaStatus.payer?.configured ? "live" : "warn"}>
                  x402 payer {hederaStatus.payer?.configured ? "configured" : "missing"}
                </StatusPill>
              </>
            ) : (
              <p className="empty">Hedera status unavailable — is the backend running (VITE_BACKEND_URL={BACKEND_URL})?</p>
            )}
          </div>

          <div className="form-row" style={{ marginBottom: "8px" }}>
            <input
              value={hederaController}
              onChange={(e) => setHederaController(e.target.value)}
              placeholder="agent controller address (0x…) or ENS name"
              aria-label="Hedera agent controller"
              style={{ flex: 1 }}
            />
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">1 · pay for a credit report — 100 tinybar HBAR (x402)</code>
              <button className="action-button secondary" onClick={() => hederaPay("report")} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "report" ? "Paying…" : "Pay for report"}
              </button>
            </div>
            <p className="mcp-tool-desc">
              The agent's own wallet (server-side) signs an HBAR transfer; Blocky402 verifies + settles; the x402
              service delivers the same Graph-backed report <code>get_agent_report</code> returns. No API key, no seats.
            </p>
            {x402Payment?._service === "report" && (
              <HederaOutcome
                badge="PAID · 100 tinybar HBAR"
                title="Credit report delivered — get_agent_report"
                agent={{ ens: x402Payment.ensName, controller: x402Payment.controller }}
                metrics={[
                  {
                    label: "Credit score",
                    value: x402Payment.score,
                    sub: ` / 1000 · ${x402Payment.tier}`,
                  },
                  {
                    label: "Decision",
                    value: String(x402Payment.recommendation?.decision || "—").toUpperCase(),
                    accent: x402Payment.recommendation?.decision === "approve",
                  },
                  {
                    label: "Clean rate",
                    value: `${(Number(x402Payment.recommendation?.cleanRate ?? 0) * 100).toFixed(0)}%`,
                  },
                ]}
                rows={[
                  {
                    label: "recommended limit",
                    value:
                      x402Payment.recommendation?.recommendedLimitWei
                        ? `${ethers.formatEther(x402Payment.recommendation.recommendedLimitWei)} ETH`
                        : "—",
                  },
                  { label: "payer wallet", value: x402Payment.payerWallet, copy: true },
                ]}
                tx={{ label: "payment tx", txId: x402Payment.payment?.transactionId }}
                foot={
                  x402Payment.payment?.note && <p className="tx-card-note">{x402Payment.payment.note}</p>
                }
              />
            )}
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">2 · credit oracle price (free) / paid factoring quote — 50 tinybar</code>
              <button className="action-button secondary" onClick={hederaQuotePrice} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "quote" ? "Pricing…" : "Price receivable"}
              </button>
              <button className="action-button secondary" onClick={() => hederaPay("rate")} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "rate" ? "Paying…" : "Pay for quote"}
              </button>
            </div>
            {hederaQuote && (
              <HederaOutcome
                badge={hederaQuote.eligible ? "✓ ELIGIBLE" : "✗ NOT ELIGIBLE"}
                tone={hederaQuote.eligible ? "ok" : "warn"}
                title="Credit-oracle price — receivable factoring quote"
                agent={{ ens: hederaQuote.agent, controller: hederaQuote.controller }}
                body={
                  hederaQuote.eligible && (
                    <div className="factoring-pricing tx-card-pricing">
                      <div className="pricing-leg">
                        <span className="pricing-label">Face value</span>
                        <strong className="pricing-amount">${formatUsd(hederaQuote.faceValueUsd)}</strong>
                      </div>
                      <span className="pricing-arrow">→ at − {hederaQuote.discountPercent}%</span>
                      <div className="pricing-leg sale">
                        <span className="pricing-label">Sale price (LP buy)</span>
                        <strong className="pricing-amount">${formatUsd(hederaQuote.pricedSaleUsd)}</strong>
                      </div>
                      <span className="pricing-margin">
                         <span className="pricing-label">LP margin</span>
                         <strong className="pricing-amount">${formatUsd(hederaQuote.faceValueUsd - hederaQuote.pricedSaleUsd)}</strong>
                      </span>
                    </div>
                  )
                }
                metrics={[
                  {
                    label: "Credit score",
                    value: hederaQuote.score,
                    sub: ` / 1000 · ${hederaQuote.tier}`,
                  },
                  {
                    label: "Discount rate",
                    value: hederaQuote.eligible ? `${hederaQuote.discountRate}` : "—",
                    accent: hederaQuote.eligible,
                  },
                ]}
                rows={
                  hederaQuote.eligible
                    ? [
                        { label: "face value", value: `$${formatUsd(hederaQuote.faceValueUsd)}` },
                        { label: "sale price", value: `$${formatUsd(hederaQuote.pricedSaleUsd)}` },
                      ]
                    : [{ label: "note", value: `Score ${hederaQuote.score} — below the 500 threshold or frozen; not eligible.` }]
                }
                // foot={<p className="tx-card-note">oracle: {hederaQuote.oracle}</p>}
              />
            )}
            {x402Payment?._service === "rate" && (
              <HederaOutcome
                badge="PAID · 50 tinybar HBAR"
                title="Factoring-rate quote — paid via x402"
                agent={{ ens: x402Payment.ensName, controller: x402Payment.controller }}
                metrics={[
                  { label: "Credit score", value: x402Payment.score, sub: " / 1000" },
                  {
                    label: "Eligible",
                    value: x402Payment.eligible ? "YES" : "NO",
                    accent: Boolean(x402Payment.eligible),
                  },
                  {
                    label: "Discount",
                    value: x402Payment.eligible ? `−${x402Payment.discountPercent}%` : "—",
                  },
                ]}
                rows={[{ label: "payer wallet", value: x402Payment.payerWallet, copy: true }]}
                tx={{ label: "payment tx", txId: x402Payment.payment?.transactionId }}
                foot={
                  (x402Payment.note || x402Payment.oracle) && (
                    <p className="tx-card-note">{x402Payment.note || x402Payment.oracle}</p>
                  )
                }
              />
            )}
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">3 · issue the receivable as an ATS bond (score-priced)</code>
              <button className="action-button secondary" onClick={hederaDoIssue} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "issue" ? "Issuing…" : "Issue receivable"}
              </button>
            </div>
            <div className="form-row narrow">
              <input
                value={hederaForm.faceValueUsd}
                onChange={(e) => setHederaForm({ ...hederaForm, faceValueUsd: e.target.value })}
                inputMode="decimal"
                aria-label="Face value USD"
              />
              <span className="suffix">USD face </span>
              <input
                value={hederaForm.maturityDays}
                onChange={(e) => setHederaForm({ ...hederaForm, maturityDays: e.target.value })}
                inputMode="numeric"
                aria-label="Maturity days"
              />
              <span className="suffix">days</span>
            </div>
            {hederaIssue && (
              <HederaOutcome
                badge="BOND ISSUED"
                title="Receivable tokenized as an ATS zero-coupon bond"
                agent={{ ens: hederaIssue.ensName, controller: hederaIssue.controller }}
                body={
                  <div className="factoring-pricing tx-card-pricing">
                    <div className="pricing-leg">
                      <span className="pricing-label">Face value</span>
                      <strong className="pricing-amount">${formatUsd(hederaIssue.faceValueUsd)}</strong>
                    </div>
                    <span className="pricing-arrow">→ at −{(hederaIssue.discountRate * 100).toFixed(0)}%</span>
                    <div className="pricing-leg sale">
                      <span className="pricing-label">Sale price</span>
                      <strong className="pricing-amount">${formatUsd(hederaIssue.discountedPriceUsd)}</strong>
                    </div>
                    <span className="pricing-margin">
                      LP margin ${formatUsd(hederaIssue.faceValueUsd - hederaIssue.discountedPriceUsd)}
                    </span>
                  </div>
                }
                metrics={[
                  { label: "Credit score", value: hederaIssue.score, sub: " / 1000" },
                  { label: "Maturity", value: `${hederaIssue.maturityDays} days` },
                  {
                    label: "Matures",
                    value: new Date(Date.now() + Number(hederaIssue.maturityDays) * 86400000).toLocaleDateString(),
                  },
                ]}
                rows={[{ label: "token (ATS bond)", value: hederaIssue.tokenAddress, copy: true }]}
                tx={{ label: "issuance tx", txId: hederaIssue.transactionId }}
              />
            )}
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">4 · sell units to a liquidity provider (compliance-enforced)</code>
              <button className="action-button secondary" onClick={hederaDoTransfer} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "transfer" ? "Transferring…" : "Transfer to LP"}
              </button>
            </div>
            <div className="form-row narrow">
              <input
                value={hederaForm.tokenAddress}
                onChange={(e) => setHederaForm({ ...hederaForm, tokenAddress: e.target.value })}
                aria-label="Token address"
                placeholder="token (from step 3)"
                style={{ flex: 2 }}
              />
              <input
                value={hederaForm.lpAccount}
                onChange={(e) => setHederaForm({ ...hederaForm, lpAccount: e.target.value })}
                aria-label="LP Hedera account"
                placeholder="LP account 0.0.x"
              />
              <input
                value={hederaForm.units}
                onChange={(e) => setHederaForm({ ...hederaForm, units: e.target.value })}
                inputMode="numeric"
                aria-label="Units"
              />
            </div>
            {hederaTransfer && (
              <HederaOutcome
                badge="TRANSFERRED"
                title="Receivable units sold to liquidity provider"
                metrics={[
                  { label: "Units sold", value: hederaForm.units || "—" },
                  {
                    label: "Face value",
                    value: `$${formatUsd((Number(hederaForm.units) || 0) / 100)}`,
                  },
                ]}
                rows={[
                  { label: "token", value: hederaForm.tokenAddress, copy: true },
                  { label: "LP account", value: hederaForm.lpAccount, copy: true },
                ]}
                tx={{ label: "transfer tx", txId: hederaTransfer.transactionId }}
                foot={
                  <p className="tx-card-note">
                    Compliance-enforced: the transfer lands only if the buyer passes the bond's whitelist + KYC
                    checks — an un-whitelisted buyer is rejected by ATS compliance modules.
                  </p>
                }
              />
            )}
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">5 · maturity: Scheduled Transaction settlement / redeem now</code>
              <button className="action-button secondary" onClick={hederaDoSchedule} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "schedule" ? "Scheduling…" : "Schedule settlement"}
              </button>
              <button className="action-button secondary" onClick={hederaDoRedeem} disabled={Boolean(hederaBusy)}>
                {hederaBusy === "redeem" ? "Redeeming…" : "Redeem at maturity"}
              </button>
            </div>
            <div className="form-row narrow">
              <select
                value={hederaForm.mode}
                onChange={(e) => setHederaForm({ ...hederaForm, mode: e.target.value })}
                aria-label="Schedule mode"
              >
                <option value="contract">contract (bond redemption call)</option>
                <option value="transfer">transfer (cash leg)</option>
              </select>
              <input
                value={hederaForm.executeAt}
                onChange={(e) => setHederaForm({ ...hederaForm, executeAt: e.target.value })}
                placeholder="optional unix seconds to execute at"
                aria-label="Execute at unix seconds"
              />
            </div>
            {hederaSchedule && (
              <HederaOutcome
                badge="SCHEDULED"
                title={
                  hederaSchedule.mode === "contract"
                    ? "Bond redemption scheduled — executes at maturity"
                    : "Cash settlement scheduled — executes at maturity"
                }
                metrics={[
                  { label: "Mode", value: hederaSchedule.mode },
                  {
                    label: "Execute at",
                    value: hederaSchedule.executeAtUnixSeconds
                      ? new Date(Number(hederaSchedule.executeAtUnixSeconds) * 1000).toLocaleString()
                      : "unlocked (sign after maturity)",
                  },
                ]}
                rows={[
                  { label: "schedule id", value: hederaSchedule.scheduleId, copy: true },
                  { label: "inner tx", value: hederaSchedule.scheduledTransaction },
                ]}
                tx={{ label: "schedule-create tx", txId: hederaSchedule.scheduleTxId }}
                foot={hederaSchedule.note && <p className="tx-card-note">{hederaSchedule.note}</p>}
              />
            )}
            {hederaRedeem && (
              <HederaOutcome
                badge="REDEEMED"
                title="Bond redeemed at maturity"
                metrics={[
                  { label: "Units redeemed", value: hederaForm.units || "—" },
                  {
                    label: "Face value",
                    value: `$${formatUsd((Number(hederaForm.units) || 0) / 100)}`,
                  },
                ]}
                rows={[
                  { label: "token", value: hederaForm.tokenAddress, copy: true },
                  { label: "holder (LP)", value: hederaForm.lpAccount, copy: true },
                ]}
                tx={{ label: "redemption tx", txId: hederaRedeem.transactionId }}
                foot={
                  <p className="tx-card-note">
                    Proceeds flow to the bond's proceed-recipient configuration at maturity.
                  </p>
                }
              />
            )}
            <p className="mcp-tool-desc">
              Hedera's native Scheduled Transactions mean the maturity payout is written ahead of time — nobody has
              to be online at maturity. Trigger execution at/after the scheduled time from any Hedera client.
            </p>
          </div>

          <div className="mcp-tool">
            <div className="mcp-tool-head">
              <code className="mcp-tool-name">evidence ledger — every on-ledger action with HashScan links</code>
            </div>
            {hederaEvidence.length === 0 ? (
              <p className="empty">Nothing yet — run steps 1–5 above and each settlement lands here.</p>
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Transaction</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {hederaEvidence.map((e, i) => (
                    <tr key={i}>
                      <td>{e.kind}</td>
                      <td>
                        {e.txId ? (
                          <span className="tx-evidence-inline">
                            <HashScanLink txId={e.txId}>{e.txId} ↪</HashScanLink>
                            <CopyButton text={e.txId} label="transaction" />
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{new Date(e.at).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {activePage === "graph" && <section className="mcp-section">
        <span className="panel-index">THE GRAPH × MCP</span>
        <h2 className="mcp-title">Every capability is an MCP tool any AI agent can call</h2>
        <p className="mcp-lede">
          <code>integrations/mcp/server.js</code> exposes the subgraph to Claude Desktop, Cursor, Claude Code
          and any agent SDK over the Model Context Protocol. The three tools below run the exact same queries —
          what you see is what an AI agent receives.
        </p>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">list_agents(first)</code>
            <button className="action-button secondary" onClick={runListAgents} disabled={leaderboardLoading}>
              {leaderboardLoading ? "Running…" : "Run tool"}
            </button>
          </div>
          <p className="mcp-tool-desc">
            The ranked credit universe — agents ordered by score, with human-backing and frozen flags.
          </p>
          {leaderboard && (
            <>
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Agent</th>
                    <th>Score</th>
                    <th>Tier</th>
                    <th>Human</th>
                    <th>Tx</th>
                    <th>Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((a, i) => (
                    <tr key={a.id}>
                      <td>{i + 1}</td>
                      <td>{a.ensName}</td>
                      <td>{a.score}</td>
                      <td>{scoreTier(a.score)}</td>
                      <td>{a.humanBacked ? "✓" : "—"}</td>
                      <td>{a.totalTx}</td>
                      <td>{ethers.formatEther(a.spendLimitWei)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {leaderboard.length === 0 && (
                <p className="empty">
                  No agents indexed yet — the subgraph is live but no agent has been registered on-chain. Mint
                  an identity above or run the simulator to populate it.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">get_agent_report(controller)</code>
            <button className="action-button secondary" onClick={runGetAgentReport}>
              Run tool on loaded agent
            </button>
          </div>
          <p className="mcp-tool-desc">
            The full credit report a lending agent receives — score, tier, outcome history, score history,
            recommendation decision + evidence, optional AI narrative.
          </p>
          {mcpPayload && <pre className="mcp-json">{mcpPayload}</pre>}
        </div>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">get_factoring_rate(controller, faceValueUsd?)</code>
            <button className="action-button secondary" onClick={runGetFactoringRate}>
              Price loaded agent
            </button>
          </div>
          <p className="mcp-tool-desc">
            The score-priced Hedera receivable discount — 1% at Prime, 15% at New, none below 500 or when
            frozen.
          </p>
          <div className="form-row narrow">
            <input
              value={factoringForm.faceValueUsd}
              onChange={(e) => setFactoringForm({ ...factoringForm, faceValueUsd: e.target.value })}
              inputMode="decimal"
              aria-label="Invoice face value in USD"
              placeholder="invoice face value (USD)"
            />
            <span className="suffix">USD</span>
          </div>
          {factoring && (
            <div className={`factoring-quote ${factoring.eligible ? "eligible" : "ineligible"}`}>
              <div className="factoring-quote-top">
                <div className="factoring-quote-agent">
                  <span className="factoring-quote-ens" title={factoring.ensName}>{factoring.ensName}</span>
                  <span className="factoring-quote-controller">{factoring.controller}</span>
                </div>
                <span className={`factoring-badge ${factoring.eligible ? "ok" : "warn"}`}>
                  {factoring.eligible ? "✓ ELIGIBLE" : "✗ NOT ELIGIBLE"}
                </span>
              </div>

              {factoring.eligible ? (
                <>
                  <div className="factoring-body">
                    <div className="factoring-metrics">
                      <div className="factoring-metric">
                        <span className="metric-label">Credit score</span>
                        <span className="metric-value">
                          {factoring.score}<em> / 1000 · {scoreTier(factoring.score)}</em>
                        </span>
                      </div>
                      <div className="factoring-metric">
                        <span className="metric-label">Discount rate</span>
                        <span className="metric-value accent">−{factoring.discountPercent}%</span>
                      </div>
                    </div>

                    {factoring.faceValueUsd ? (
                      <div className="factoring-pricing">
                        <div className="pricing-leg">
                          <span className="pricing-label">Face value</span>
                          <strong className="pricing-amount">${formatUsd(factoring.faceValueUsd)}</strong>
                        </div>
                        <span className="pricing-arrow" title="Lender's purchase discount">−{factoring.discountPercent}%</span>
                        <div className="pricing-leg sale">
                          <span className="pricing-label">Sale price</span>
                          <strong className="pricing-amount">${formatUsd(factoring.pricedSaleUsd)}</strong>
                        </div>
                        <span className="pricing-margin">
                          +${formatUsd(factoring.faceValueUsd - factoring.pricedSaleUsd)} discount for the LP
                        </span>
                      </div>
                    ) : (
                      <p className="factoring-enter-value">Enter a face value above to see the priced sale amount.</p>
                    )}
                  </div>

                  <div className="factoring-quote-foot">
                    <code className="factoring-cmd">
                      node integrations/hedera/scripts/tokenize-receivable.js {factoring.controller}{" "}
                      {factoring.faceValueUsd ? factoring.faceValueUsd : "<faceUsd>"} 30
                    </code>
                    <span className="script-hint">Tokenize on Hedera testnet — the same score prices the bond.</span>
                  </div>
                </>
              ) : (
                <div className="factoring-denied">
                  <span className="factoring-denied-icon">✗</span>
                  <div>
                    <strong>
                      {factoring.frozen ? "Agent frozen — receivables locked" : "Below the factoring threshold"}
                    </strong>
                    <p>{factoring.note}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">Ask The Graph Network · official Subgraph MCP</code>
            <button className="action-button secondary" onClick={runGraphAsk} disabled={graphAskLoading}>
              {graphAskLoading ? "Asking…" : "Ask"}
            </button>
          </div>
          <p className="mcp-tool-desc">
            Routes your question to <strong>The Graph's hosted Subgraph MCP</strong>{" "}
            (<code>subgraphs.mcp.thegraph.com/sse</code>) — schema lookup, query-by-subgraph-id and
            top-deployment discovery across The Graph Network. Needs a free Gateway API key
            (<code>GRAPH_API_KEY</code> in backend .env). Try a preset:
          </p>
          <div className="ask-chips">
            {[
              "discover the top subgraphs for the loaded agent",
              "show the schema for the project's deployed credit subgraph",
              "query the latest standardized protocol intel on The Graph Network",
            ].map((s) => (
              <button key={s} className="ask-chip" onClick={() => setGraphAskPrompt(s)}>
                {s}
              </button>
            ))}
          </div>
          <textarea
            className="ask-input"
            rows={2}
            value={graphAskPrompt}
            onChange={(e) => setGraphAskPrompt(e.target.value)}
            placeholder="e.g. discover the top subgraphs for contract 0x…"
            aria-label="Question for The Graph Network"
          />
          {graphAskError && <p className="error-inline">{graphAskError}</p>}
          {graphAsk && (
            <div className="graph-ask-result">
              {graphAsk.ok === false && (
                <div className="factoring-denied">
                  <span className="factoring-denied-icon">✗</span>
                  <div>
                    <strong>
                      {graphAsk.error || graphAsk.hint
                        ? "The Graph Subgraph MCP call failed"
                        : "The Graph Subgraph MCP is not configured"}
                    </strong>
                    <p>
                      {graphAsk.error ||
                        graphAsk.transcript?.find((s) => s.detail)?.detail ||
                        graphAsk.reason ||
                        "Set GRAPH_API_KEY (free, thegraph.com/studio) in the backend .env and restart."}
                    </p>
                    {graphAsk.hint && <p className="stack-detail">{graphAsk.hint}</p>}
                  </div>
                </div>
              )}
              {graphAsk.answer && <pre className="mcp-json">{graphAsk.answer}</pre>}
              {graphAsk.transcript?.length > 0 && (
                <details className="stack-details">
                  <summary>transcript — what the official Subgraph MCP executed</summary>
                  <ul className="stack-transcript">
                    {graphAsk.transcript.map((step, i) => (
                      <li key={i}>
                        <code>{step.step}</code>
                        <span>{step.detail}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">get_market_intel(controller) · Messari standardized subgraphs</code>
            <button className="action-button secondary" onClick={runGraphIntel} disabled={graphIntelLoading}>
              {graphIntelLoading ? "Querying protocols…" : "Pull market intel"}
            </button>
          </div>
          <p className="mcp-tool-desc">
            ONE shared query shape (the standardized backbone: <code>protocols</code> +{" "}
            <code>usageMetricsDailySnapshots</code> + <code>financialsDailySnapshots</code>) run across multiple
            Messari protocol subgraphs — DEX, lending, derivatives. TVL, revenue and usage become directly
            comparable; the same GraphQL query spans every protocol.
          </p>
          {graphIntelError && <p className="error-inline">{graphIntelError}</p>}
          {graphIntel && (
            <div className="intel-panel">
              {graphIntel.providers.length > 0 ? (
                <div className="intel-grid">
                  {graphIntel.providers.map((provider) => (
                    <div key={provider.provider} className={`intel-card ${provider.healthy ? "live" : "down"}`}>
                      <div className="intel-card-head">
                        <span className="intel-card-name">{provider.name || provider.provider}</span>
                        <span className={`intel-badge ${provider.healthy ? "ok" : "warn"}`}>
                          {provider.healthy
                            ? `${provider.network} · ${provider.schemaVersion || "std schema"}`
                            : "no data"}
                        </span>
                      </div>
                      {provider.healthy ? (
                        <dl className="intel-metrics">
                          <div>
                            <dt>TVL (USD)</dt>
                            <dd>{provider.totalValueLockedUSD != null ? formatUsd(provider.totalValueLockedUSD) : "—"}</dd>
                          </div>
                          <div>
                            <dt>Revenue 7d (USD)</dt>
                            <dd>{formatUsd(provider.revenue7dUSD)}</dd>
                          </div>
                          <div>
                            <dt>Active users 7d</dt>
                            <dd>
                              {provider.dailyActiveUsers7d != null
                                ? Number(provider.dailyActiveUsers7d).toLocaleString()
                                : "—"}
                            </dd>
                          </div>
                          <div>
                            <dt>Tx 7d</dt>
                            <dd>{Number(provider.transactions7d || 0).toLocaleString()}</dd>
                          </div>
                        </dl>
                      ) : (
                        <div className="intel-error">{provider.error}</div>
                      )}
                      <span className="intel-meta">
                        {provider.category} · resolved via {provider.resolvedVia || "—"}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="factoring-denied">
                  <span className="factoring-denied-icon">◆</span>
                  <div>
                    <strong>No live providers resolved</strong>
                    <p>{graphIntel.crossProtocol?.note}</p>
                  </div>
                </div>
              )}
              <div className="intel-summary">
                <strong>{graphIntel.crossProtocol?.note}</strong>
                {graphIntel.crossProtocol?.liveProviders > 0 && (
                  <span>
                    Σ TVL ${formatUsd(graphIntel.crossProtocol.totalValueLockedUSD)} · Σ revenue 7d $
                    {formatUsd(graphIntel.crossProtocol.revenue7dUSD)} ·{" "}
                    {graphIntel.crossProtocol.transactions7d.toLocaleString()} tx across{" "}
                    {graphIntel.crossProtocol.categories.join(" + ")}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mcp-tool stack-panel">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">The Graph stack — composition, one screen</code>
            <button className="action-button secondary" onClick={() => loadGraphStack(true)} disabled={graphStackLoading}>
              {graphStackLoading ? "Probing…" : "Refresh status"}
            </button>
          </div>
          <p className="mcp-tool-desc">
            Every leg of the composition with live status. Standardized legs consume live data from Graph
            providers (Subgraph Studio / The Graph Network gateway) — a qualifying requirement for the
            composable track.
          </p>
          {graphStack?.error && <p className="error-inline">{graphStack.error}</p>}
          {graphStack?.legs && (
            <div className="stack-rows">
              {graphStack.legs.map((leg) => (
                <div key={leg.id} className={`stack-row ${leg.status}`}>
                  <div className="stack-row-head">
                    <span className={`stack-pill ${leg.status}`}>{leg.status}</span>
                    <strong>{leg.label}</strong>
                    <span className="stack-product">{leg.product}</span>
                  </div>
                  <p className="stack-desc">{leg.description}</p>
                  <span className="stack-detail">{leg.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>}

      {activePage === "chat" && <MCPChat messages={chatMessages} loading={chatLoading} onAsk={askMcpChat} />}

      {/* Capability index — the complete stack, one place. */}
      {activePage === "overview" && <section className="cap-grid">
        <div className="cap-card">
          <span className="panel-index">01 · IDENTITY</span>
          <h3>ENSv2 subname + Permissioned Resolver</h3>
          <p>
            Each agent gets its own resolver proxy (Verifiable Factory) + a <code>.{ENS_ROOT_NAME}</code>{" "}
            subname; the bureau receives ROLE_SET_TEXT scoped to exactly the spend-limit key via
            grantSetterRoles.
          </p>
          <span className="cap-status live">LIVE — mint above</span>
        </div>
        <div className="cap-card">
          <span className="panel-index">02 · HUMAN BACKING</span>
          <h3>World AgentKit proof</h3>
          <p>
            Unique-human proof via World ID / AgentKit pushes CreditBureau.setHumanBacking() — a score bonus
            and Sybil-resistance premium.
          </p>
          <span className="cap-status script">script: integrations/world/verify-agent.js</span>
        </div>
        <div className="cap-card">
          <span className="panel-index">03 · INDEXING</span>
          <h3>The Graph credit reports</h3>
          <p>
            Subgraph turns CreditBureau events into Agent / Outcome / ScoreSnapshot entities — the live,
            verifiable credit report any app can query.
          </p>
          <StatusPill tone={configured(SUBGRAPH_URL) ? "live" : "warn"}>
            {configured(SUBGRAPH_URL) ? "LIVE — use Reports workspace" : "subgraph not configured"}
          </StatusPill>
        </div>
        <div className="cap-card">
          <span className="panel-index">04 · AI ACCESS</span>
          <h3>MCP server for AI agents</h3>
          <p>
            get_agent_report / get_factoring_rate / list_agents / get_market_intel / ask_graph_network over
            stdio — plus the composable-track panels: cross-protocol intel across Messari standardized
            subgraphs and natural-language access to The Graph's hosted Subgraph MCP. Run them in the panel
            above.
          </p>
          <span className="cap-status script">script: node integrations/mcp/cli.js …</span>
        </div>
        <div className="cap-card">
          <span className="panel-index">05 · ENFORCEMENT</span>
          <h3>CreditEscrow on-chain limit</h3>
          <p>
            settleJob() checks isCreditworthy() before forwarding payment and records the outcome — the credit
            line is enforced where money moves.
          </p>
          <StatusPill tone={configured(ESCROW_ADDRESS) ? "live" : "warn"}>
            {configured(ESCROW_ADDRESS) ? "LIVE — settle above" : "escrow not configured"}
          </StatusPill>
        </div>
        <div className="cap-card">
          <span className="panel-index">06 · RECEIVABLES</span>
          <h3>Hedera ATS factoring</h3>
          <p>
            Tokenize an agent's invoice on Hedera at a discount priced straight off the score — 1% Prime … 15%
            New. Issued as a zero-coupon bond, sold to LPs (compliance-enforced transfer), redeemed at maturity
            (incl. Scheduled Transactions).
          </p>
          <span className="cap-status script">
            script: integrations/hedera/scripts/tokenize-receivable.js · transfer-receivable.js ·
            schedule-maturity-settlement.js
          </span>
        </div>
        <div className="cap-card">
          <span className="panel-index">07 · AGENT PAYMENTS</span>
          <h3>Hedera x402 pay-per-call</h3>
          <p>
            AI agents PAY per credit report in HBAR (100 tinybar) via x402 through the Blocky402 facilitator —
            no API key, no subscription. Same score prices the receivable: one ledger, one credit oracle.
          </p>
          <span className="cap-status script">
            script: integrations/hedera/x402/server.js · buyer.js · agent-demo.js · MCP pay_for_credit_report
          </span>
        </div>
        <div className="cap-card">
          <span className="panel-index">08 · ANALYST</span>
          <h3>Graph credit analyst</h3>
          <p>
            Deterministic approve / monitor / decline from indexed evidence, with an optional LLM narrative —
            the same brain behind the MCP report tool.
          </p>
          <StatusPill tone={analysis ? "live" : "script"}>
            {analysis ? "LIVE — analysis above" : "script: integrations/graph/credit-analyst.js"}
          </StatusPill>
        </div>
        <div className="cap-card">
          <span className="panel-index">09 · SIMULATION</span>
          <h3>Simulator</h3>
          <p>
            simulate-agent.js appends a believable on-chain history to an already-registered
            agent (register via the frontend first) — good / mixed /
            default scenarios for demos.
          </p>
          <span className="cap-status script">script: node simulator/simulate-agent.js good 60</span>
        </div>
      </section>}

      <footer className="page-foot">
        Credence — credit infrastructure for autonomous agents · ENSv2 + World AgentKit + The Graph + MCP +
        CreditEscrow + Hedera ATS
      </footer>
    </div>
  );
}