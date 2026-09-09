require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const sepoliaAccounts = /^0x[a-fA-F0-9]{64}$/.test(deployerKey || "") ? [deployerKey] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: sepoliaAccounts,
    },
    // ENSv2 beta currently lives on Sepolia — this is where CreditBureau
    // and any ENSv2 subname registrations should be deployed for the demo.
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
