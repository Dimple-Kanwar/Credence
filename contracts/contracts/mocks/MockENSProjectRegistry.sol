// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test double for the project's ENSv2 UserRegistry proxy. Mirrors the
///         two calls CreditBureau makes at registration: getOwner(tokenId) and
///         getResolver(label). In production the real PermissionedRegistry
///         returns the owner of the name's ERC1155 token.
contract MockENSProjectRegistry {
    mapping(uint256 => address) public ownerOf;
    mapping(string => address) public resolverOf;

    function setOwner(uint256 tokenId, address owner) external {
        ownerOf[tokenId] = owner;
    }

    function setResolver(string calldata label, address resolver) external {
        resolverOf[label] = resolver;
    }

    function getOwner(uint256 tokenId) external view returns (address) {
        return ownerOf[tokenId];
    }

    function getResolver(string calldata label) external view returns (address) {
        return resolverOf[label];
    }
}