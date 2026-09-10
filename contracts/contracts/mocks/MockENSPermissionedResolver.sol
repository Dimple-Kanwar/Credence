// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for the ENSv2 Permissioned Resolver. The real resolver
///         enforces Enhanced Access Control: setText for a key only succeeds
///         when the caller holds ROLE_SET_TEXT on that (key) resource —
///         granted to CreditBureau via grantSetterRoles(). This mock just
///         stores the record so tests can assert the bureau's EAC write path.
///
///         Mirrors the latest ENSv2 resolver write interface: setters take
///         the DNS-encoded name (`bytes`), not a bytes32 namehash, and the
///         node is derived from the name on-chain. The convenience getter
///         `text(bytes32 node, key)` is mock-only — the real resolver has no
///         standalone getters (records are read through resolve()).
contract MockENSPermissionedResolver {
    mapping(bytes32 => mapping(string => string)) public entries;

    event TextSet(bytes32 indexed node, string key, string value);

    function setText(bytes calldata name, string calldata key, string calldata value) external {
        bytes32 node = _nodeFromDnsName(name);
        entries[node][key] = value;
        emit TextSet(node, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return entries[node][key];
    }

    /// @dev ENSIP-1 namehash computed from a DNS-encoded name (matches the
    ///      real resolver's NameCoder.namehash and CreditBureau's _namehash):
    ///      labels are collected left-to-right, then folded from the rightmost
    ///      label (the TLD) toward the leftmost, so the TLD is hashed first.
    function _nodeFromDnsName(bytes calldata name) internal pure returns (bytes32 node) {
        uint256[128] memory start; // label content start (after length byte)
        uint256[128] memory len; // label content length
        uint256 n = 0;
        uint256 i = 0;
        while (i < name.length) {
            uint256 l = uint8(name[i]);
            i++;
            if (l == 0) break; // root label terminator
            require(i + l <= name.length, "MockResolver: truncated label");
            start[n] = i;
            len[n] = l;
            n++;
            i += l;
        }
        for (uint256 k = n; k > 0; k--) { // fold TLD (rightmost) first
            uint256 idx = k - 1;
            bytes32 labelHash = keccak256(bytes(name[start[idx]:start[idx] + len[idx]]));
            node = keccak256(abi.encodePacked(node, labelHash));
        }
    }
}