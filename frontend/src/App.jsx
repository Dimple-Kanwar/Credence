import { useState } from "react";
import { ethers } from "ethers";
import { request, gql } from "graphql-request";
import { discountRateForScore } from "./credit.js";

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

// Tiny SVG sparkline for score-over-time history.
function Sparkline({ data, width = 320, height = 72 }) {
  if (!data || data.length < 2) {
    return <p className="empty">Not enough score history to chart yet (the subgraph records ScoreUpdated events).</p>;
  }
  const points = data.slice().reverse(); // chronological order
  const min = Math.min(...points.map((p) => Number(p.newScore)), 0);
  const max = Math.max(...points.map((p) => Number(p.newScore)), 1000);
  const range = max - min || 1;
  const step = width / (points.length - 1);
  const y = (v) => (height - 8 - ((v - min) / range) * (height - 16)).toFixed(1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${y(p.newScore)}`);
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Score over time">
      <polyline points={coords.join(" ")} fill="none" stroke="#6f9be8" strokeWidth="2" />
      {points.map((p, i) => (
        <circle key={i} cx={(i * step).toFixed(1)} cy={y(p.newScore)} r="2.5" fill="#c97d4b" />
      ))}
      <text x="0" y={height - 2} fill="#9aa4b2" fontSize="9" fontFamily="monospace">{points[0].newScore}</text>
      <text x={width - 24} y={height - 2} fill="#9aa4b2" fontSize="9" fontFamily="monospace">{points[points.length - 1].newScore}</text>
    </svg>
  );
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
  const [registerForm, setRegisterForm] = useState({ label: "trader", humanBacked: true });
  const [settleForm, setSettleForm] = useState({ payee: "", amount: "0.001", job: "invoice-001" });
  const [factoringForm, setFactoringForm] = useState({ faceValueUsd: "1000" });
  const [leaderboard, setLeaderboard] = useState(null);
  const [mcpPayload, setMcpPayload] = useState(null);
  const [factoring, setFactoring] = useState(null);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(false);
  const [leaderboardLoading, setLeaderboardLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const readProvider = new ethers.JsonRpcProvider(RPC_URL);
  const configured = (v) => Boolean(v && !String(v).includes("<") && !String(v).includes("..."));

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
      const signer = await browserProvider.getSigner();
      const address = await signer.getAddress();
      setWallet(signer);
      setWalletAddress(address);
      setSettleForm((current) => ({ ...current, payee: current.payee || address }));
      setNotice("Wallet connected on Sepolia.");
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
    setError(null);
    setNotice(null);
    if (!wallet) return setError("Connect a Sepolia wallet first.");
    if (!CREDIT_BUREAU_ADDRESS)
      return setError("CreditBureau is not configured. Set VITE_CREDIT_BUREAU_ADDRESS in frontend/.env.");
    if (!ENS_REGISTRAR_ADDRESS)
      return setError("ENS registrar is not configured. Set VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS in frontend/.env.");
    const label = registerForm.label.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,32}$/.test(label)) return setError("Use a label with 3-32 lowercase letters, numbers, or hyphens.");
    setAction("register");
    try {
      const controller = await wallet.getAddress();
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
      await (await registrar.register(label, controller, resolver, registerForm.humanBacked, duration)).wait();

      const resolverContract = new ethers.Contract(resolver, RESOLVER_ABI, wallet);
      const setterCalldata = resolverContract.interface.encodeFunctionData("setText", [
        dnsEncode(`${label}.${ENS_ROOT_NAME}`),
        SPEND_LIMIT_TEXT_KEY,
        "",
      ]);
      await (await resolverContract.grantSetterRoles(setterCalldata, CREDIT_BUREAU_ADDRESS)).wait();

      const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, wallet);
      await (await bureau.registerAgent(`${label}.${ENS_ROOT_NAME}`, registerForm.humanBacked)).wait();

      setAddressInput(controller);
      setNotice(`${label}.${ENS_ROOT_NAME} registered. Loading its live report…`);
      await lookupAgentFor(controller);
    } catch (err) {
      setError(messageFor(err));
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

  const discount = profile ? discountRateForScore(Number(profile.score)) : null;
  const decisionLabel = {
    approve: "APPROVE",
    "approve-with-monitoring": "APPROVE · MONITOR",
    review: "REVIEW",
    decline: "DECLINE",
  };
  const configItems = [
    { label: "Bureau", value: CREDIT_BUREAU_ADDRESS },
    { label: "Escrow", value: ESCROW_ADDRESS },
    { label: "Registrar", value: ENS_REGISTRAR_ADDRESS },
    { label: "Subgraph", value: SUBGRAPH_URL },
  ];

  return (
    <div className="page">
      <header className="masthead">
        <div>
          <span className="eyebrow">ETH ONLINE / SEPOLIA</span>
          <span className="wordmark">Credence</span>
        </div>
        <span className="subhead">credit infrastructure for autonomous agents</span>
        <button className="wallet-button" onClick={connectWallet}>
          {walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Connect wallet"}
        </button>
      </header>

      {/* Live configuration strip — every address is env-driven, never baked in. */}
      <section className="config-strip">
        <span className="config-title">LIVE CONFIG</span>
        {configItems.map((item) => (
          <div key={item.label} className={`config-item ${configured(item.value) ? "ok" : "warn"}`}>
            {item.label} {configured(item.value) ? shortAddr(item.value) : "not set"}
          </div>
        ))}
        <div className="config-item ok">ENS root {ENS_ROOT_NAME}</div>
      </section>

      <section className="intro">
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
      </section>

      <section className="lookup">
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
      </section>

      {error && <p className="error">{error}</p>}
      {notice && <p className="notice">{notice}</p>}

      <div className="action-grid">
        <section className="action-panel">
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
          <label className="check">
            <input
              type="checkbox"
              checked={registerForm.humanBacked}
              onChange={(e) => setRegisterForm({ ...registerForm, humanBacked: e.target.checked })}
            />{" "}
            World human-backed proof (AgentKit)
          </label>
          <button className="action-button" onClick={registerAgent} disabled={action === "register"}>
            {action === "register" ? "Waiting for wallet…" : "Register identity"}
          </button>
          <p className="script-hint">script: node integrations/ens/register-single-agent.js &lt;label&gt; &lt;controller&gt;</p>
        </section>

        <section className="action-panel">
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
        </section>
      </div>

      {profile && (
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
                <dd>{profile.humanBacked ? "Yes — World AgentKit" : "No"}</dd>
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
          <section className="panel">
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
                    Narrative leg runs server-side via <code>integrations/graph/credit-analyst.js</code> or the
                    MCP <code>get_agent_report</code> tool when an OpenAI key is configured; set
                    VITE_OPENAI_API_KEY to enable it in-browser. The deterministic decision above uses only
                    on-chain / Graph data.
                  </p>
                )}
                <p className="script-hint">script: node integrations/graph/credit-analyst.js {profile.controller}</p>
              </>
            ) : (
              <p className="empty">Pull a report to run the analyst.</p>
            )}
          </section>

          <section className="panel two-col">
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
          </section>

          <section className="panel">
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
          </section>

          <section className="panel">
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
          </section>
        </main>
      )}

      {/* The Graph × MCP — the same tools an AI agent calls over stdio, run here in the browser. */}
      <section className="mcp-section">
        <span className="panel-index">THE GRAPH × MCP</span>
        <h2 className="mcp-title">Every capability is an MCP tool any AI agent can call</h2>
        <p className="mcp-lede">
          <code>integrations/mcp/server.js</code> exposes the subgraph to Claude Desktop, Cursor, Claude Code
          and any agent SDK over the Model Context Protocol. The three tools below run the exact same queries —
          what you see is what an AI agent receives. From a script:{" "}
          <code>node integrations/mcp/cli.js get_agent_report 0x…</code>
        </p>

        <div className="mcp-tool">
          <div className="mcp-tool-head">
            <code className="mcp-tool-name">list_agents(first)</code>
            <button className="action-button secondary" onClick={runListAgents} disabled={leaderboardLoading}>
              {leaderboardLoading ? "Running…" : "Run tool"}
            </button>
          </div>
          <p className="mcp-tool-desc">
            The ranked credit universe — agents ordered by score, with human-backing and frozen flags. Same
            query: <code>LIST_AGENTS_QUERY</code> in the MCP server.
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
          {factoring && <pre className="mcp-json compact">{JSON.stringify(factoring, null, 2)}</pre>}
        </div>
      </section>

      {/* Capability index — the complete stack, one place. */}
      <section className="cap-grid">
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
          <span className={`cap-status ${configured(SUBGRAPH_URL) ? "live" : "warn"}`}>
            {configured(SUBGRAPH_URL) ? "LIVE — pull a report above" : "subgraph not configured"}
          </span>
        </div>
        <div className="cap-card">
          <span className="panel-index">04 · AI ACCESS</span>
          <h3>MCP server for AI agents</h3>
          <p>
            get_agent_report / get_factoring_rate / list_agents over stdio — any MCP client pulls the same
            evidence-backed recommendation. Run them in the panel above.
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
          <span className={`cap-status ${configured(ESCROW_ADDRESS) ? "live" : "warn"}`}>
            {configured(ESCROW_ADDRESS) ? "LIVE — settle above" : "escrow not configured"}
          </span>
        </div>
        <div className="cap-card">
          <span className="panel-index">06 · RECEIVABLES</span>
          <h3>Hedera ATS factoring</h3>
          <p>
            Tokenize an agent's invoice on Hedera at a discount priced straight off the score — 1% Prime … 15%
            New.
          </p>
          <span className="cap-status script">script: integrations/hedera/scripts/tokenize-receivable.js</span>
        </div>
        <div className="cap-card">
          <span className="panel-index">07 · ANALYST</span>
          <h3>Graph credit analyst</h3>
          <p>
            Deterministic approve / monitor / decline from indexed evidence, with an optional LLM narrative —
            the same brain behind the MCP report tool.
          </p>
          <span className={`cap-status ${analysis ? "live" : "script"}`}>
            {analysis ? "LIVE — analysis above" : "script: integrations/graph/credit-analyst.js"}
          </span>
        </div>
        <div className="cap-card">
          <span className="panel-index">08 · SIMULATION</span>
          <h3>Simulator</h3>
          <p>
            simulate-agent.js mints a fresh ENSv2 identity and drives a believable history — good / mixed /
            default scenarios for demos.
          </p>
          <span className="cap-status script">script: node simulator/simulate-agent.js good 60</span>
        </div>
      </section>

      <footer className="page-foot">
        Credence — credit infrastructure for autonomous agents · ENSv2 + World AgentKit + The Graph + MCP +
        CreditEscrow + Hedera ATS
      </footer>
    </div>
  );
}