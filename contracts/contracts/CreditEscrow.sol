// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICreditBureau {
    function isCreditworthy(address controller, uint256 requestedAmountWei) external view returns (bool);
    function recordOutcome(address controller, uint8 outcome, uint256 amountWei, bytes32 jobId) external;
}

/// @title CreditEscrow
/// @notice A minimal settlement boundary that enforces an agent's bureau limit.
contract CreditEscrow {
    ICreditBureau public immutable bureau;

    mapping(bytes32 => bool) public settledJobs;

    event JobSettled(
        bytes32 indexed jobId,
        address indexed agent,
        address indexed payee,
        uint256 amountWei
    );

    constructor(address bureauAddress) {
        require(bureauAddress != address(0), "CreditEscrow: zero bureau");
        bureau = ICreditBureau(bureauAddress);
    }

    function settleJob(bytes32 jobId, address payable payee) external payable {
        require(jobId != bytes32(0), "CreditEscrow: empty job id");
        require(payee != address(0), "CreditEscrow: zero payee");
        require(!settledJobs[jobId], "CreditEscrow: job settled");
        require(msg.value > 0, "CreditEscrow: zero amount");
        require(
            bureau.isCreditworthy(msg.sender, msg.value),
            "CreditEscrow: credit limit exceeded"
        );

        settledJobs[jobId] = true;
        (bool sent, ) = payee.call{value: msg.value}("");
        require(sent, "CreditEscrow: payment failed");

        bureau.recordOutcome(msg.sender, 0, msg.value, jobId);
        emit JobSettled(jobId, msg.sender, payee, msg.value);
    }
}
