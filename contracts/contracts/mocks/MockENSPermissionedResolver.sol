// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for the ENSv2 Permissioned Resolver. The real resolver
///         enforces Enhanced Access Control: setText for a key only succeeds
///         when the caller holds ROLE_SET_TEXT on that (node, key) resource —
///         granted to CreditBureau via authorizeTextRoles(). This mock just
///         stores the record so tests can assert the bureau's EAC write path.
contract MockENSPermissionedResolver {
    mapping(bytes32 => mapping(string => string)) public entries;

    event TextSet(bytes32 indexed node, string key, string value);

    function setText(bytes32 node, string calldata key, string calldata value) external {
        entries[node][key] = value;
        emit TextSet(node, key, value);
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return entries[node][key];
    }
}