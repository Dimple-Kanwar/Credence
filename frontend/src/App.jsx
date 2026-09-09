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
const ENS_FACTORY_ADDRESS = import.meta.env.VITE_ENS_VERIFIABLE_FACTORY || "0x894bc9cc8ff1ad96b8a288c86a8c71d662c07780";
const ENS_RESOLVER_IMPL = import.meta.env.VITE_ENS_PERMISSIONED_RESOLVER_IMPL || "0xa9d3814ab151bf6e37a427432795371a8361614e";

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
const RESOLVER_INIT_ABI = ["function initialize(address admin, uint256 roleBitmap, bytes[] setters)"];
const RESOLVER_ABI = ["function authorizeTextRoles(bytes toName, string key, address account, bool grant) external"];
const REGISTRAR_ABI = ["function register(string label, address controller, address resolver, bool humanBacked, uint64 duration) external returns (uint256 tokenId)"];

const AGENT_HISTORY_QUERY = gql`
  query AgentHistory($id: ID!) {
    agent(id: $id) {
      ensName
      score
      spendLimitWei
      humanBacked
      frozen
      totalTx
      outcomes(orderBy: timestamp, orderDirection: desc, first: 15) {
        outcomeType
        amountWei
        timestamp
      }
    }
  }
`;

function scoreTier(score) {
  if (score >= 900) return "Prime";
  if (score >= 800) return "Established";
  if (score >= 650) return "Building";
  if (score >= 500) return "New";
  return "Restricted";
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

export default function App() {
  const [addressInput, setAddressInput] = useState("");
  const [profile, setProfile] = useState(null);
  const [history, setHistory] = useState([]);
  const [wallet, setWallet] = useState(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [registerForm, setRegisterForm] = useState({ label: "trader", humanBacked: true });
  const [settleForm, setSettleForm] = useState({ payee: "", amount: "0.001", job: "invoice-001" });
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const readProvider = new ethers.JsonRpcProvider(RPC_URL);

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

  async function lookupAgent() {
    setError(null);
    setLoading(true);
    setProfile(null);
    setHistory([]);
    if (!CREDIT_BUREAU_ADDRESS) {
      setLoading(false);
      return setError("CreditBureau is not configured. Copy frontend/.env.example to frontend/.env and set VITE_CREDIT_BUREAU_ADDRESS.");
    }
    try {
      const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, readProvider);
      let controller = addressInput.trim();
      if (!isAddress(controller)) controller = await bureau.resolveByEnsName(controller);
      if (controller === ethers.ZeroAddress) throw new Error("No controller is registered for that ENS name.");
      const onchain = await bureau.getProfile(controller);
      if (!onchain.registered) {
        setError("No agent registered at this address.");
        setLoading(false);
        return;
      }
      setProfile(onchain);

      try {
        const data = await request(SUBGRAPH_URL, AGENT_HISTORY_QUERY, {
          id: controller.toLowerCase(),
        });
        setHistory(data.agent?.outcomes ?? []);
      } catch (subgraphErr) {
        // Subgraph is optional for the on-chain read to still work in a demo.
        console.warn("Subgraph query failed, falling back to on-chain-only view:", subgraphErr);
      }
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setLoading(false);
    }
  }

  async function lookupAgentFor(controller) {
    const bureau = new ethers.Contract(CREDIT_BUREAU_ADDRESS, CREDIT_BUREAU_ABI, readProvider);
    const onchain = await bureau.getProfile(controller);
    setProfile(onchain);
    if (SUBGRAPH_URL) {
      try {
        const data = await request(SUBGRAPH_URL, AGENT_HISTORY_QUERY, { id: controller.toLowerCase() });
        setHistory(data.agent?.outcomes ?? []);
      } catch { setHistory([]); }
    }
  }

  async function registerAgent() {
    setError(null);
    setNotice(null);
    if (!wallet) return setError("Connect a Sepolia wallet first.");
    if (!CREDIT_BUREAU_ADDRESS)
      return setError("CreditBureau is not configured. Copy frontend/.env.example to frontend/.env and set VITE_CREDIT_BUREAU_ADDRESS.");
    if (!ENS_REGISTRAR_ADDRESS) return setError("ENS registrar is not configured. Set VITE_ENS_AGENT_SUBNAME_REGISTRAR_ADDRESS after deploying the project registrar.");
    const label = registerForm.label.trim().toLowerCase();
    if (!/^[a-z0-9-]{3,32}$/.test(label)) return setError("Use a label with 3-32 lowercase letters, numbers, or hyphens.");
    setAction("register");
    try {
      const controller = await wallet.getAddress();
      const factory = new ethers.Contract(ENS_FACTORY_ADDRESS, FACTORY_ABI, wallet);
      const salt = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "address", "uint256"], [ethers.keccak256(ethers.toUtf8Bytes("OwnedResolver")), controller, 0n])));
      const initData = new ethers.Interface(RESOLVER_INIT_ABI).encodeFunctionData("initialize", [controller, BigInt("0x" + "1".repeat(64)), []]);
      const deployTx = await factory.deployProxy(ENS_RESOLVER_IMPL, salt, initData);
      const deployReceipt = await deployTx.wait();
      const factoryInterface = new ethers.Interface(FACTORY_ABI);
      const deployed = deployReceipt.logs.map((log) => { try { return factoryInterface.parseLog(log); } catch { return null; } }).find((event) => event?.name === "ProxyDeployed");
      if (!deployed) throw new Error("ENS resolver deployment event was not found.");
      const resolver = deployed.args.proxyAddress;
      const registrar = new ethers.Contract(ENS_REGISTRAR_ADDRESS, REGISTRAR_ABI, wallet);
      const duration = 365n * 24n * 60n * 60n;
      await (await registrar.register(label, controller, resolver, registerForm.humanBacked, duration)).wait();
      const resolverContract = new ethers.Contract(resolver, RESOLVER_ABI, wallet);
      await (await resolverContract.authorizeTextRoles(dnsEncode(`${label}.${ENS_ROOT_NAME}`), "com.agentcreditbureau.spend-limit-wei", CREDIT_BUREAU_ADDRESS, true)).wait();
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

  const discount = profile ? discountRateForScore(Number(profile.score)) : null;

  return (
    <div className="page">
      <header className="masthead">
        <div><span className="eyebrow">ETHONLINE / SEPOLIA</span><span className="wordmark">Credence</span></div>
        <span className="subhead">credit infrastructure for autonomous agents</span>
        <button className="wallet-button" onClick={connectWallet}>{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Connect wallet"}</button>
      </header>

      <section className="intro"><p className="kicker">THE TRUST LAYER FOR MACHINE ECONOMIES</p><h1>Every agent has a<br /><em>ledger of consequences.</em></h1><p className="lede">ENSv2 identity, human backing, and a credit line enforced at the moment money moves.</p></section>

      <section className="lookup">
        <input
          className="lookup-input"
          placeholder="agent controller address — 0x..."
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
          <span className="panel-index">01 / IDENTITY</span><h2>Mint an agent identity</h2><p>Deploy a permissioned ENSv2 resolver, mint a subname, and pin its first report to the bureau.</p>
          <div className="form-row"><input value={registerForm.label} onChange={(e) => setRegisterForm({ ...registerForm, label: e.target.value })} aria-label="ENS label" /><span className="suffix">.{ENS_ROOT_NAME}</span></div>
          <label className="check"><input type="checkbox" checked={registerForm.humanBacked} onChange={(e) => setRegisterForm({ ...registerForm, humanBacked: e.target.checked })} /> World human-backed proof</label>
          <button className="action-button" onClick={registerAgent} disabled={action === "register"}>{action === "register" ? "Waiting for wallet…" : "Register identity"}</button>
        </section>
        <section className="action-panel">
          <span className="panel-index">02 / SETTLEMENT</span><h2>Run a credit-limited job</h2><p>CreditEscrow checks the connected agent's spend limit before forwarding payment and recording a clean outcome.</p>
          <div className="form-row"><input value={settleForm.amount} onChange={(e) => setSettleForm({ ...settleForm, amount: e.target.value })} inputMode="decimal" aria-label="Amount in ETH" /><span className="suffix">ETH</span></div>
          <input className="full-input" value={settleForm.payee} onChange={(e) => setSettleForm({ ...settleForm, payee: e.target.value })} placeholder="payee address" aria-label="Payee address" />
          <input className="full-input" value={settleForm.job} onChange={(e) => setSettleForm({ ...settleForm, job: e.target.value })} placeholder="job reference" aria-label="Job reference" />
          <button className="action-button secondary" onClick={settleJob} disabled={action === "settle"}>{action === "settle" ? "Settling…" : "Settle through escrow"}</button>
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
                <dd>{profile.ensName} <a href={`https://sepolia.etherscan.io/address/${profile.controller}`} target="_blank" rel="noreferrer">↗</a></dd>
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

          <section className="panel">
            <h2>Receivables factoring rate</h2>
            {discount !== null ? (
              <p className="factoring-line">
                At this score, an outstanding invoice from this agent would tokenize on Hedera at a{" "}
                <strong>{(discount * 100).toFixed(0)}%</strong> discount to face value.
              </p>
            ) : (
              <p className="factoring-line factoring-ineligible">
                Score is below the factoring threshold — this agent's receivables are not currently
                eligible for tokenization.
              </p>
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
    </div>
  );
}
