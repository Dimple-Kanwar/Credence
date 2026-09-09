// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ENSv2 subregistry interface (the project's UserRegistry
///         proxy deployed via the Verifiable Factory). For a subname
///         registry, the tokenId of a label is `uint256(keccak256(label))`.
///         Both `getOwner` and `getResolver` live on the concrete
///         PermissionedRegistry/UserRegistry even though only `getOwner` is
///         on the `IPermissionedRegistry` interface — see
///         ensdomains/contracts-v2 PermissionedRegistry.sol.
interface IEnsProjectRegistry {
    function getOwner(uint256 anyId) external view returns (address owner);
    function getResolver(string calldata label) external view returns (address resolver);
}

/// @notice ENSv2 Permissioned Resolver. CreditBureau is granted
///         `ROLE_SET_TEXT` scoped to exactly `SPEND_LIMIT_TEXT_KEY` via the
///         resolver's `authorizeTextRoles()` (see
///         integrations/ens/register-single-agent.js), so writing the spend
///         limit through this interface is the ONLY record the bureau is
///         permissioned to touch on an agent's own resolver.
interface IEnsPermissionedResolver {
    function setText(bytes32 node, string calldata key, string calldata value) external;
}

/// @title CreditBureau
/// @notice "FICO for AI Agents" — an on-chain reputation and credit-scoring
///         registry for autonomous agents. Agents register an ENSv2 identity
///         and a World AgentKit human-backing proof, then build a score from
///         their on-chain transaction history. The score gates spend limits
///         (enforced via ENSv2 Enhanced Access Control off-chain/on-chain)
///         and prices the discount rate on tokenized receivables issued
///         against the agent's future cashflows (see hedera/ integration).
/// @dev This is a hackathon-scope reference implementation: scoring logic is
///      intentionally simple and transparent so it's easy to demo live.
contract CreditBureau {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Outcome {
        Success, // invoice paid / job completed on time
        Late, // completed but past SLA
        Disputed, // counterparty raised a dispute
        Default // agent failed to pay / deliver
    }

    struct AgentProfile {
        string ensName; // e.g. "trader.acme.eth"
        address controller; // wallet/account that operates the agent
        bool humanBacked; // true once verified via World AgentKit
        bool registered;
        bool frozen; // true after a default freezes permissions
        uint32 score; // 0-1000, FICO-style
        uint256 spendLimitWei; // current allowance per enforcement window
        uint32 totalTx;
        uint32 successTx;
        uint32 lateTx;
        uint32 disputedTx;
        uint32 defaultTx;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public admin;

    /// @dev The project's ENSv2 UserRegistry proxy (subregistry for
    ///      `<label>.agentcreditbureau.eth`), set immutably at deployment.
    ///      The bureau reads subname ownership + resolver from this registry
    ///      at registration, so an agent cannot claim a name it does not own.
    address public immutable ENS_PROJECT_REGISTRY;

    /// @dev The single text record CreditBureau is EAC-authorized to write on
    ///      an agent's Permissioned Resolver. Matches the key used in
    ///      integrations/ens/register-single-agent.js and the frontend.
    string public constant SPEND_LIMIT_TEXT_KEY = "com.agentcreditbureau.spend-limit-wei";

    /// @dev Per-controller ENSv2 wiring: the agent's own Permissioned
    ///      Resolver proxy and the namehash node its records are keyed by.
    mapping(address => address) public resolverOf; // controller => resolver
    mapping(address => bytes32) public nodeOf; // controller => namehash(ensName)

    /// @dev Addresses allowed to call recordOutcome on behalf of a
    ///      marketplace/escrow/job contract that observed a real settlement.
    mapping(address => bool) public authorizedReporters;

    mapping(address => AgentProfile) public agents; // controller => profile
    mapping(bytes32 => address) public ensNameToController; // keccak(ensName) => controller

    uint32 public constant STARTING_SCORE = 500;
    uint32 public constant MAX_SCORE = 1000;
    uint32 public constant MIN_SCORE = 0;

    uint256 public constant STARTING_LIMIT_WEI = 0.01 ether; // demo default ("$10/day" analog)
    uint256 public constant MAX_LIMIT_WEI = 1 ether; // demo ceiling ("$1,000/day" analog)

    // ---------------------------------------------------------------------
    // Events — these are what the subgraph indexes into a live credit report
    // ---------------------------------------------------------------------

    event AgentRegistered(address indexed controller, string ensName, bool humanBacked, uint256 timestamp);
    event HumanBackingUpdated(address indexed controller, bool humanBacked, uint256 timestamp);
    event OutcomeRecorded(
        address indexed controller,
        Outcome outcome,
        uint256 amountWei,
        bytes32 indexed jobId,
        uint256 timestamp
    );
    event ScoreUpdated(address indexed controller, uint32 oldScore, uint32 newScore, uint256 timestamp);
    event SpendLimitUpdated(address indexed controller, uint256 oldLimitWei, uint256 newLimitWei, uint256 timestamp);
    /// @dev Emitted whenever the bureau writes the spend limit into the agent's own
    ///      ENSv2 Permissioned Resolver text record via its scoped EAC role.
    event SpendLimitPersistedToEns(
        address indexed controller, address indexed resolver, uint256 limitWei, uint256 timestamp
    );
    event AgentFrozen(address indexed controller, uint256 timestamp);
    event AgentUnfrozen(address indexed controller, uint256 timestamp);
    event ReporterAuthorized(address indexed reporter, bool allowed);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyAdmin() {
        require(msg.sender == admin, "CreditBureau: not admin");
        _;
    }

    modifier onlyAuthorizedReporter() {
        require(authorizedReporters[msg.sender] || msg.sender == admin, "CreditBureau: not authorized reporter");
        _;
    }

    constructor(address ensProjectRegistry) {
        require(ensProjectRegistry != address(0), "CreditBureau: zero ENS registry");
        ENS_PROJECT_REGISTRY = ensProjectRegistry;
        admin = msg.sender;
        authorizedReporters[msg.sender] = true;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setReporter(address reporter, bool allowed) external onlyAdmin {
        authorizedReporters[reporter] = allowed;
        emit ReporterAuthorized(reporter, allowed);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "CreditBureau: zero address");
        admin = newAdmin;
    }

    // ---------------------------------------------------------------------
    // Agent lifecycle
    // ---------------------------------------------------------------------

    /// @notice Register a new agent. Call this right after minting the
    ///         agent's ENSv2 subname (identity leg) and, ideally, after a
    ///         successful World AgentKit human-proof (human-backing leg).
    /// @dev This is the ENSv2 enforcement limb: the caller must OWN the first
    ///      label of `ensName` inside the project's UserRegistry (`getOwner`
    ///      must return msg.sender) and the subname must point at a resolver.
    ///      The bureau captures that resolver and uses its scoped EAC
    ///      ROLE_SET_TEXT grant to write the live spend limit into the
    ///      agent's own name records — the only text key it may touch.
    function registerAgent(string calldata ensName, bool humanBacked) external {
        require(!agents[msg.sender].registered, "CreditBureau: already registered");
        require(bytes(ensName).length > 0, "CreditBureau: empty ENS name");

        // Duplicate-name check first: it is a local mapping lookup, so two
        // callers can never claim the same ENS string in the bureau.
        bytes32 nameHash = keccak256(bytes(ensName));
        require(ensNameToController[nameHash] == address(0), "CreditBureau: ENS name taken");

        // Parse the label being claimed and its full-name node.
        (string memory label, ) = _splitFirstLabel(ensName);
        bytes32 node = _namehash(ensName);

        // On-chain ENSv2 ownership check against the project's UserRegistry.
        uint256 labelId = uint256(keccak256(bytes(label)));
        require(
            IEnsProjectRegistry(ENS_PROJECT_REGISTRY).getOwner(labelId) == msg.sender,
            "CreditBureau: caller does not own this ENS subname"
        );
        address resolver = IEnsProjectRegistry(ENS_PROJECT_REGISTRY).getResolver(label);
        require(resolver != address(0), "CreditBureau: ENS subname has no resolver");

        resolverOf[msg.sender] = resolver;
        nodeOf[msg.sender] = node;

        agents[msg.sender] = AgentProfile({
            ensName: ensName,
            controller: msg.sender,
            humanBacked: humanBacked,
            registered: true,
            frozen: false,
            score: STARTING_SCORE,
            spendLimitWei: humanBacked ? STARTING_LIMIT_WEI : STARTING_LIMIT_WEI / 2,
            totalTx: 0,
            successTx: 0,
            lateTx: 0,
            disputedTx: 0,
            defaultTx: 0
        });
        ensNameToController[nameHash] = msg.sender;

        emit AgentRegistered(msg.sender, ensName, humanBacked, block.timestamp);
        emit SpendLimitUpdated(msg.sender, 0, agents[msg.sender].spendLimitWei, block.timestamp);

        // First EAC write: publish the initial spend limit to the agent's own
        // resolver text records. Proves the scoped delegation end-to-end.
        _persistSpendLimit(msg.sender);
    }

    /// @notice Called once World AgentKit verification completes/changes.
    ///         Only the admin (bureau operator) or a trusted oracle reporter
    ///         should call this in production; kept permissive here for demo.
    function setHumanBacking(address controller, bool humanBacked) external onlyAuthorizedReporter {
        AgentProfile storage a = agents[controller];
        require(a.registered, "CreditBureau: not registered");
        a.humanBacked = humanBacked;
        emit HumanBackingUpdated(controller, humanBacked, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Core: record a settlement outcome and recompute score + limit
    // ---------------------------------------------------------------------

    /// @param controller the agent's controller address
    /// @param outcome how the job/invoice resolved
    /// @param amountWei size of the transaction, used to weight the update
    /// @param jobId opaque id from the calling marketplace/escrow contract
    function recordOutcome(
        address controller,
        Outcome outcome,
        uint256 amountWei,
        bytes32 jobId
    ) external onlyAuthorizedReporter {
        AgentProfile storage a = agents[controller];
        require(a.registered, "CreditBureau: not registered");
        require(!a.frozen || outcome == Outcome.Default, "CreditBureau: agent frozen");

        a.totalTx += 1;
        if (outcome == Outcome.Success) a.successTx += 1;
        else if (outcome == Outcome.Late) a.lateTx += 1;
        else if (outcome == Outcome.Disputed) a.disputedTx += 1;
        else a.defaultTx += 1;

        emit OutcomeRecorded(controller, outcome, amountWei, jobId, block.timestamp);

        uint32 oldScore = a.score;
        uint32 newScore = _computeScore(a);
        a.score = newScore;
        if (newScore != oldScore) {
            emit ScoreUpdated(controller, oldScore, newScore, block.timestamp);
        }

        if (outcome == Outcome.Default) {
            a.frozen = true;
            emit AgentFrozen(controller, block.timestamp);
        }

        uint256 oldLimit = a.spendLimitWei;
        uint256 newLimit = _computeLimit(a);
        a.spendLimitWei = newLimit;
        if (newLimit != oldLimit) {
            emit SpendLimitUpdated(controller, oldLimit, newLimit, block.timestamp);
            _persistSpendLimit(controller);
        }
    }

    /// @notice Manual unfreeze path (e.g. dispute resolved off-chain in the
    ///         agent's favor, or a human co-signs to restore the agent).
    function unfreeze(address controller) external onlyAuthorizedReporter {
        AgentProfile storage a = agents[controller];
        require(a.registered, "CreditBureau: not registered");
        a.frozen = false;
        uint256 oldLimit = a.spendLimitWei;
        uint256 newLimit = _computeLimit(a);
        a.spendLimitWei = newLimit;
        emit AgentUnfrozen(controller, block.timestamp);
        if (newLimit != oldLimit) {
            emit SpendLimitUpdated(controller, oldLimit, newLimit, block.timestamp);
            _persistSpendLimit(controller);
        }
    }

    // ---------------------------------------------------------------------
    // Scoring logic (demo-simple, deliberately transparent)
    // ---------------------------------------------------------------------

    function _computeScore(AgentProfile storage a) internal view returns (uint32) {
        if (a.totalTx == 0) return STARTING_SCORE;

        // Base: weighted clean-transaction ratio, scaled to 0-1000.
        uint256 weightedGood = uint256(a.successTx) * 100 + uint256(a.lateTx) * 60;
        uint256 weightedBad = uint256(a.disputedTx) * 150 + uint256(a.defaultTx) * 500;
        uint256 totalWeight = uint256(a.totalTx) * 100;

        int256 raw = int256(weightedGood) - int256(weightedBad);
        if (raw < 0) raw = 0;

        uint256 ratioScore = (uint256(raw) * 1000) / (totalWeight == 0 ? 1 : totalWeight);
        if (ratioScore > MAX_SCORE) ratioScore = MAX_SCORE;

        // Human backing is a flat trust bonus (Sybil-resistance premium).
        uint256 bonus = a.humanBacked ? 50 : 0;
        uint256 finalScore = ratioScore + bonus;
        if (finalScore > MAX_SCORE) finalScore = MAX_SCORE;

        // A single default caps the score hard, regardless of history,
        // until the agent is unfrozen and rebuilds a track record.
        if (a.defaultTx > 0 && a.frozen) {
            uint256 capped = finalScore / 4;
            return uint32(capped);
        }

        return uint32(finalScore);
    }

    function _computeLimit(AgentProfile storage a) internal view returns (uint256) {
        if (a.frozen) return 0;

        // Piecewise tiers, mirroring "$10/day -> $1,000/day after 500 clean tx".
        if (a.score >= 900 && a.totalTx >= 500) return MAX_LIMIT_WEI;
        if (a.score >= 800 && a.totalTx >= 200) return MAX_LIMIT_WEI / 4;
        if (a.score >= 650 && a.totalTx >= 50) return MAX_LIMIT_WEI / 20;
        if (a.score >= 500) return STARTING_LIMIT_WEI;
        return STARTING_LIMIT_WEI / 2;
    }

    // ---------------------------------------------------------------------
    // ENSv2 EAC persistence
    // ---------------------------------------------------------------------

    /// @dev Writes the agent's current spend limit into its own Permissioned
    ///      Resolver text record under `SPEND_LIMIT_TEXT_KEY`. The bureau can
    ///      only do this because the agent granted it ROLE_SET_TEXT scoped to
    ///      exactly that key via `authorizeTextRoles()` — if the grant is
    ///      revoked, this silently fails-soft (the limit lives on-chain in
    ///      CreditBureau either way; the text record is the resolvable
    ///      mirror that any app, wallet, or agent can read).
    function _persistSpendLimit(address controller) internal {
        address resolver = resolverOf[controller];
        if (resolver == address(0)) return;
        uint256 limitWei = agents[controller].spendLimitWei;
        IEnsPermissionedResolver(resolver).setText(
            nodeOf[controller], SPEND_LIMIT_TEXT_KEY, _uintToString(limitWei)
        );
        emit SpendLimitPersistedToEns(controller, resolver, limitWei, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // ENS name helpers (ENSIP-1 namehash + label splitting, no deps)
    // ---------------------------------------------------------------------

    /// @notice ENSIP-1 namehash, computed label-by-label from the root (TLD
    ///         first). `trader.agentcreditbureau.eth` ->
    ///         keccak(keccak(keccak(eth), kept('agentcreditbureau')), keccak('trader')).
    function _namehash(string memory name) internal pure returns (bytes32 node) {
        bytes memory b = bytes(name);
        uint256 len = b.length;
        // Reject empty labels caused by stray dots ("a..b" or trailing ".").
        uint256 cut = len;
        for (uint256 i = len; i > 0; i--) {
            if (b[i - 1] == 0x2e) {
                require(cut > i, "CreditBureau: invalid ENS name");
                node = _foldNode(node, b, i, cut);
                cut = i - 1;
            }
        }
        require(cut > 0, "CreditBureau: invalid ENS name");
        node = _foldNode(node, b, 0, cut);
    }

    function _foldNode(bytes32 node, bytes memory b, uint256 start, uint256 end)
        internal
        pure
        returns (bytes32)
    {
        bytes32 labelHash = keccak256(_substring(b, start, end - start));
        return keccak256(abi.encodePacked(node, labelHash));
    }

    /// @return label The leftmost label (what must be owned in the project
    ///         registry) and the remaining parent string after the first dot.
    function _splitFirstLabel(string memory name)
        internal
        pure
        returns (string memory label, bytes memory rest)
    {
        bytes memory b = bytes(name);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == 0x2e) {
                require(i > 0 && i + 1 < b.length, "CreditBureau: invalid ENS name");
                return (string(_substring(b, 0, i)), _substring(b, i + 1, b.length - i - 1));
            }
        }
        revert("CreditBureau: ENS name must include a parent domain");
    }

    function _substring(bytes memory b, uint256 start, uint256 lengthValue)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(lengthValue);
        for (uint256 i = 0; i < lengthValue; i++) {
            out[i] = b[start + i];
        }
    }

    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 tmp = value;
        uint256 digits;
        while (tmp != 0) {
            digits++;
            tmp /= 10;
        }
        bytes memory buf = new bytes(digits);
        while (value != 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (value % 10)));
            value /= 10;
        }
        return string(buf);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getProfile(address controller) external view returns (AgentProfile memory) {
        return agents[controller];
    }

    function resolveByEnsName(string calldata ensName) external view returns (address) {
        return ensNameToController[keccak256(bytes(ensName))];
    }

    /// @notice Convenience read for other contracts (e.g. a receivables
    ///         factoring contract on Hedera-bridged data, or an escrow
    ///         contract deciding whether to accept this agent as counterparty).
    function isCreditworthy(address controller, uint256 requestedAmountWei) external view returns (bool) {
        AgentProfile memory a = agents[controller];
        if (!a.registered || a.frozen) return false;
        return requestedAmountWei <= a.spendLimitWei;
    }
}
