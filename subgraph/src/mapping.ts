import { BigInt } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  HumanBackingUpdated,
  OutcomeRecorded,
  ScoreUpdated,
  SpendLimitUpdated,
  AgentFrozen,
  AgentUnfrozen,
} from "../generated/CreditBureau/CreditBureau";
import { Agent, Outcome, ScoreSnapshot, SpendLimitChange } from "../generated/schema";

const OUTCOME_LABELS = ["Success", "Late", "Disputed", "Default"];

function loadOrCreateAgent(address: string, timestamp: BigInt): Agent {
  let agent = Agent.load(address);
  if (agent == null) {
    agent = new Agent(address);
    agent.ensName = "";
    agent.humanBacked = false;
    agent.registered = false;
    agent.frozen = false;
    agent.score = 500;
    agent.spendLimitWei = BigInt.zero();
    agent.totalTx = 0;
    agent.successTx = 0;
    agent.lateTx = 0;
    agent.disputedTx = 0;
    agent.defaultTx = 0;
    agent.registeredAt = timestamp;
    agent.updatedAt = timestamp;
  }
  return agent as Agent;
}

export function handleAgentRegistered(event: AgentRegistered): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.ensName = event.params.ensName;
  agent.humanBacked = event.params.humanBacked;
  agent.registered = true;
  agent.registeredAt = event.params.timestamp;
  agent.updatedAt = event.params.timestamp;
  agent.save();
}

export function handleHumanBackingUpdated(event: HumanBackingUpdated): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.humanBacked = event.params.humanBacked;
  agent.updatedAt = event.params.timestamp;
  agent.save();
}

export function handleOutcomeRecorded(event: OutcomeRecorded): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);

  agent.totalTx += 1;
  const outcomeIndex = event.params.outcome;
  if (outcomeIndex == 0) agent.successTx += 1;
  else if (outcomeIndex == 1) agent.lateTx += 1;
  else if (outcomeIndex == 2) agent.disputedTx += 1;
  else agent.defaultTx += 1;
  agent.updatedAt = event.params.timestamp;
  agent.save();

  const outcomeEntityId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const outcome = new Outcome(outcomeEntityId);
  outcome.agent = id;
  outcome.outcomeType = OUTCOME_LABELS[outcomeIndex];
  outcome.amountWei = event.params.amountWei;
  outcome.jobId = event.params.jobId;
  outcome.timestamp = event.params.timestamp;
  outcome.blockNumber = event.block.number;
  outcome.save();
}

export function handleScoreUpdated(event: ScoreUpdated): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.score = event.params.newScore.toI32();
  agent.updatedAt = event.params.timestamp;
  agent.save();

  const snapshotId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const snapshot = new ScoreSnapshot(snapshotId);
  snapshot.agent = id;
  snapshot.oldScore = event.params.oldScore.toI32();
  snapshot.newScore = event.params.newScore.toI32();
  snapshot.timestamp = event.params.timestamp;
  snapshot.save();
}

export function handleSpendLimitUpdated(event: SpendLimitUpdated): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.spendLimitWei = event.params.newLimitWei;
  agent.updatedAt = event.params.timestamp;
  agent.save();

  const changeId = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const change = new SpendLimitChange(changeId);
  change.agent = id;
  change.oldLimitWei = event.params.oldLimitWei;
  change.newLimitWei = event.params.newLimitWei;
  change.timestamp = event.params.timestamp;
  change.save();
}

export function handleAgentFrozen(event: AgentFrozen): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.frozen = true;
  agent.updatedAt = event.params.timestamp;
  agent.save();
}

export function handleAgentUnfrozen(event: AgentUnfrozen): void {
  const id = event.params.controller.toHexString();
  const agent = loadOrCreateAgent(id, event.params.timestamp);
  agent.frozen = false;
  agent.updatedAt = event.params.timestamp;
  agent.save();
}
