const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("CreditBureau", function () {
  let bureau, registry, resolver, admin, agentController, other;

  const Outcome = { Success: 0, Late: 1, Disputed: 2, Default: 3 };
  const SPEND_LIMIT_KEY = "com.agentcreditbureau.spend-limit-wei";

  /** ENSIP-1 namehash, matching CreditBureau's on-chain helper. */
  function namehash(name) {
    const labels = name.split(".");
    let node = "0x" + "00".repeat(32);
    for (let i = labels.length - 1; i >= 0; i--) {
      node = ethers.keccak256(
        ethers.concat([node, ethers.keccak256(ethers.toUtf8Bytes(labels[i]))])
      );
    }
    return node;
  }

  function labelHash(label) {
    return BigInt(ethers.keccak256(ethers.toUtf8Bytes(label)));
  }

  /** Give `account` ownership of `label` in the mock registry with a resolver. */
  async function grantEnsIdentity(label, account, resolverAddress) {
    await registry.setOwner(labelHash(label), account.address);
    await registry.setResolver(label, resolverAddress);
  }

  beforeEach(async function () {
    [admin, agentController, other] = await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory("MockENSProjectRegistry");
    registry = await MockRegistry.deploy();
    await registry.waitForDeployment();

    const MockResolver = await ethers.getContractFactory("MockENSPermissionedResolver");
    resolver = await MockResolver.deploy();
    await resolver.waitForDeployment();

    const CreditBureau = await ethers.getContractFactory("CreditBureau");
    bureau = await CreditBureau.deploy(await registry.getAddress());
    await bureau.waitForDeployment();

    await grantEnsIdentity("trader", agentController, await resolver.getAddress());
  });

  it("registers a new agent with a starting score and limit", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    const profile = await bureau.getProfile(agentController.address);
    expect(profile.ensName).to.equal("trader.acme.eth");
    expect(profile.humanBacked).to.equal(true);
    expect(profile.score).to.equal(500);
    expect(profile.frozen).to.equal(false);
  });

  it("rejects registration when the caller does not own the ENS subname", async function () {
    await expect(
      bureau.connect(other).registerAgent("trader.acme.eth", true)
    ).to.be.revertedWith("CreditBureau: caller does not own this ENS subname");
  });

  it("rejects names without an owning ENS label or a resolver", async function () {
    await expect(
      bureau.connect(agentController).registerAgent("unowned.agentcreditbureau.eth", true)
    ).to.be.revertedWith("CreditBureau: caller does not own this ENS subname");

    await grantEnsIdentity("resolverless", agentController, ethers.ZeroAddress);
    await expect(
      bureau.connect(agentController).registerAgent("resolverless.agentcreditbureau.eth", true)
    ).to.be.revertedWith("CreditBureau: ENS subname has no resolver");
  });

  it("prevents duplicate ENS name registration", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    await expect(
      bureau.connect(other).registerAgent("trader.acme.eth", true)
    ).to.be.revertedWith("CreditBureau: ENS name taken");
  });

  it("writes the initial spend limit to the agent's resolver via the EAC-scoped role", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    const node = namehash("trader.acme.eth");

    // The bureau captured the subname's resolver and published the limit as
    // a text record on the agent's own Permissioned Resolver.
    expect(await bureau.resolverOf(agentController.address)).to.equal(await resolver.getAddress());
    expect(await bureau.nodeOf(agentController.address)).to.equal(node);
    expect(await resolver.text(node, SPEND_LIMIT_KEY)).to.equal(
      ethers.parseEther("0.01").toString()
    );
  });

  it("raises the score and spend limit after a run of clean transactions", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    const node = namehash("trader.acme.eth");

    for (let i = 0; i < 60; i++) {
      await bureau.recordOutcome(
        agentController.address,
        Outcome.Success,
        ethers.parseEther("0.001"),
        ethers.encodeBytes32String(`job-${i}`)
      );
    }

    const profile = await bureau.getProfile(agentController.address);
    expect(profile.score).to.be.gt(500);
    expect(profile.spendLimitWei).to.be.gt(ethers.parseEther("0.01"));

    // The raised limit was mirrored into the agent's ENSv2 text record.
    expect(await resolver.text(node, SPEND_LIMIT_KEY)).to.equal(profile.spendLimitWei.toString());
  });

  it("freezes the agent and zeroes the spend limit after a default", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    await bureau.recordOutcome(
      agentController.address,
      Outcome.Default,
      ethers.parseEther("0.5"),
      ethers.encodeBytes32String("job-default")
    );

    const profile = await bureau.getProfile(agentController.address);
    expect(profile.frozen).to.equal(true);
    expect(profile.spendLimitWei).to.equal(0);

    await expect(
      bureau.isCreditworthy(agentController.address, 1)
    ).to.not.be.reverted; // view call still works, just returns false
    expect(await bureau.isCreditworthy(agentController.address, 1)).to.equal(false);
  });

  it("only authorized reporters can record outcomes", async function () {
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);
    await expect(
      bureau.connect(other).recordOutcome(
        agentController.address,
        Outcome.Success,
        ethers.parseEther("0.001"),
        ethers.encodeBytes32String("job-x")
      )
    ).to.be.revertedWith("CreditBureau: not authorized reporter");
  });

  it("enforces the bureau limit at the escrow boundary", async function () {
    const Escrow = await ethers.getContractFactory("CreditEscrow");
    const escrow = await Escrow.deploy(await bureau.getAddress());
    await escrow.waitForDeployment();
    await bureau.setReporter(await escrow.getAddress(), true);
    await bureau.connect(agentController).registerAgent("trader.acme.eth", true);

    const amount = ethers.parseEther("0.005");
    await expect(
      escrow.connect(agentController).settleJob(
        ethers.encodeBytes32String("job-escrow"),
        other.address,
        { value: amount }
      )
    ).to.emit(escrow, "JobSettled");

    expect((await bureau.getProfile(agentController.address)).totalTx).to.equal(1);
    await expect(
      escrow.connect(agentController).settleJob(
        ethers.encodeBytes32String("job-too-large"),
        other.address,
        { value: ethers.parseEther("0.02") }
      )
    ).to.be.revertedWith("CreditEscrow: credit limit exceeded");
  });
});