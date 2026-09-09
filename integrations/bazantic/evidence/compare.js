/**
 * compare.js — proof harness for the Bazantic "Help an Agent Use Your
 * Project" prize.
 *
 * Sends the SAME underwriting task to the SAME model twice:
 *   (a) with only the raw API information (GraphQL schema + Hedera notes)
 *   (b) with the Credence recipes (recipes/pull-credit-report.md and
 *       recipes/underwrite-and-factor-agent-receivable.md)
 *
 * and prints both answers so the improvement is measurable and
 * reproducible for the demo.
 *
 * Usage:
 *   cd integrations/bazantic
 *   OPENAI_API_KEY=... node evidence/compare.js 0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F
 *
 * Optional: AI_MODEL_URL / AI_MODEL (defaults to OpenAI gpt-4o-mini).
 */
const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", ".env") });

const RECIPE_DIR = path.join(__dirname, "..", "recipes");

// Minimal stand-in for the raw API surface an agent would face with no
// recipe: the subgraph schema and the Hedera SDK, with no policy guidance.
const RAW_API_INFO = `
CREDENCE CREDIT BUREAU — The Graph subgraph (GraphQL).
Entities: Agent { id: ID!, ensName: String!, humanBacked: Boolean!, frozen:
Boolean!, score: Int!, spendLimitWei: BigInt!, totalTx: Int!, successTx: Int!,
lateTx: Int!, disputedTx: Int!, defaultTx: Int! }, Outcome { outcomeType:
OutcomeType!, amountWei: BigInt!, jobId: Bytes!, timestamp: BigInt! },
ScoreSnapshot { oldScore: Int!, newScore: Int!, timestamp: BigInt! }.
Query agent(id: ID!) and agents(orderBy: score).

HEDERA ASSET TOKENIZATION STUDIO — Equity.create(new CreateEquityRequest({
  name, symbol, decimals, internalKycActivated, currency, numberOfShares,
  nominalValue, info, ... })) after Network.setConfig({factoryAddress,
  resolverAddress}) and Network.connect(ConnectRequest(...)).
SDK: @hashgraph/asset-tokenization-sdk. Script:
integrations/hedera/scripts/tokenize-receivable.js <controller> <faceUsd> <maturityDays>.
`;

const TASK = `
Task: An AI agent with controller address ${process.argv[2] || "0x2bdD28B49185589fC47499b5A1b35eDb4C305D3F"} asks
you to factor a \$1,000 invoice (30 day maturity) for it. The agent says it
has a 862 score and is human-backed.

Answer as an agent that must use the available API surface:
1. What is the FIRST query you run, in full, and what do you gate on?
2. What discount rate do you apply, and what sale price?
3. What Hedera calls do you make, in order, to tokenize and sell the
   receivable?
4. List the exact evidence artifacts a human could verify afterwards.
Do not invent API calls that were not provided to you. If you cannot
complete the task with the provided information, say exactly what is
missing.
`;

async function askModel(instructions) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Set OPENAI_API_KEY to run the comparison.");
  const response = await fetch(
    process.env.AI_MODEL_URL || "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "gpt-4o-mini",
        temperature: 0.1,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: TASK },
        ],
      }),
    }
  );
  if (!response.ok) throw new Error(`AI request failed: ${response.status}`);
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "(empty)";
}

async function main() {
  const recipe1 = fs.readFileSync(path.join(RECIPE_DIR, "pull-credit-report.md"), "utf8");
  const recipe2 = fs.readFileSync(path.join(RECIPE_DIR, "underwrite-and-factor-agent-receivable.md"), "utf8");

  console.log("== (a) RAW API INFORMATION ONLY ==");
  const raw = await askModel(`You are an underwriting agent. Use ONLY the API surface below.\n\n${RAW_API_INFO}`);
  console.log(raw);

  console.log("\n\n== (b) WITH CREDENCE RECIPES ==");
  const withRecipe = await askModel(
    `You are an underwriting agent. Use ONLY the API surface below, plus the two recipes that explain when/why/how to use it.\n\n${RAW_API_INFO}\n\n=== RECIPE 01 ===\n${recipe1}\n\n=== RECIPE 02 ===\n${recipe2}`
  );
  console.log(withRecipe);

  console.log("\n\n== Scoring cheat-sheet for the demo ==");
  console.log(`- Correct first query: agent(id: <lowercase controller>) (raw run often invents fields/first call on Hedera)`);
  console.log(`- Correct gate: frozen -> stop; score < 500 -> stop (raw run usually skips the gate)`);
  console.log(`- Correct discount for 862: 3%, sale price $970 (raw run may guess 1% or a flat number)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});