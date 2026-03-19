import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { customChains } from "./custom-chains";
import dotenv from "dotenv";
import fs from "fs";
import { getMinimalUUPSContract, getNetworkType } from "./addresses";

dotenv.config();

function toPkEnvVar(networkName: string): string {
  return `${networkName.replace(/([A-Z])/g, "_$1").toUpperCase()}_PRIVATE_KEY`;
}

function with0x(value: string): `0x${string}` {
  return (value.startsWith("0x") ? value : `0x${value}`) as `0x${string}`;
}

/**
 * Gets the full deployment bytecode for ERC1967Proxy
 */
async function getProxyBytecode(
  implementationAddress: string,
  initCalldata: Hex
): Promise<Hex> {
  const proxyArtifact = await hre.artifacts.readArtifact("ERC1967Proxy");

  const constructorArgs = encodeAbiParameters(
    [
      { name: "implementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    [implementationAddress as `0x${string}`, initCalldata]
  );

  return (proxyArtifact.bytecode + constructorArgs.slice(2)) as Hex;
}

async function deployBytecode(
  deployer: any,
  publicClient: any,
  bytecode: Hex,
  label: string
): Promise<{ address: `0x${string}`; txHash: `0x${string}` }> {
  const txHash = await deployer.sendTransaction({
    data: bytecode,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const address = receipt.contractAddress as `0x${string}` | undefined;

  if (!address) {
    throw new Error(`${label} deployment failed: contractAddress missing in receipt (${txHash})`);
  }

  return { address, txHash };
}

/**
 * Random-address deployment (no CREATE2 factory)
 *
 * Process:
 * 1. Deploy MinimalUUPS placeholder via normal CREATE
 * 2. Deploy ERC1967 proxies via normal CREATE (pointing to MinimalUUPS)
 * 3. Deploy real implementation contracts via normal CREATE
 * 4. Write deployment info to JSON file
 */
async function main() {
  const networkIdx = process.argv.indexOf("--network");
  const networkName = networkIdx !== -1 ? process.argv[networkIdx + 1] : undefined;
  const custom = networkName ? customChains[networkName] : undefined;

  let publicClient: any;
  let deployer: any;

  if (custom) {
    const rpcUrl = custom.rpcUrls.default.http[0];
    const pkEnv = toPkEnvVar(networkName!);
    const pkRaw = process.env[pkEnv];
    if (!pkRaw) throw new Error(`Set ${pkEnv} in your .env`);

    publicClient = createPublicClient({ chain: custom, transport: http(rpcUrl) });
    deployer = createWalletClient({
      account: privateKeyToAccount(with0x(pkRaw)),
      chain: custom,
      transport: http(rpcUrl),
    });
  } else {
    const { viem } = await hre.network.connect();
    publicClient = await viem.getPublicClient();
    [deployer] = await viem.getWalletClients();
  }

  if (!deployer) {
    const currentNetworkName = hre.network.name;
    console.error("");
    console.error("❌ ERROR: No wallet configured for this network.");
    console.error("");
    console.error("   Please ensure a private key is configured for the selected network.");
    console.error(`   Example variable: ${currentNetworkName.toUpperCase().replace(/-/g, "_")}_PRIVATE_KEY`);
    console.error("");
    process.exit(1);
  }

  const chainId = await publicClient.getChainId();
  const networkType = getNetworkType(chainId);
  const minimalUUPSContract = getMinimalUUPSContract(chainId);

  console.log("Deploying ERC-8004 Contracts (Random Address Mode)");
  console.log("====================================================");
  console.log("Network type:", networkType);
  console.log("Chain ID:", chainId);
  console.log("MinimalUUPS contract:", minimalUUPSContract);
  console.log("Deployer address:", deployer.account.address);
  console.log("");

  const minimalUUPSArtifact = await hre.artifacts.readArtifact(minimalUUPSContract);
  const identityImplArtifact = await hre.artifacts.readArtifact("IdentityRegistryUpgradeable");
  const reputationImplArtifact = await hre.artifacts.readArtifact("ReputationRegistryUpgradeable");
  const validationImplArtifact = await hre.artifacts.readArtifact("ValidationRegistryUpgradeable");

  console.log(`PHASE 1: Deploying ${minimalUUPSContract} Placeholder (CREATE)`);
  console.log("=====================================================");
  console.log("");

  console.log(`1. Deploying ${minimalUUPSContract} placeholder...`);
  const minimalUUPS = await deployBytecode(
    deployer,
    publicClient,
    minimalUUPSArtifact.bytecode as Hex,
    minimalUUPSContract
  );
  console.log(`   ✅ Deployed at: ${minimalUUPS.address}`);
  console.log(`   Tx: ${minimalUUPS.txHash}`);
  console.log("");

  console.log("PHASE 2: Deploying ERC1967 Proxies (CREATE)");
  console.log("=============================================");
  console.log("");

  console.log("2. Deploying IdentityRegistry proxy...");
  const identityInitData = encodeFunctionData({
    abi: minimalUUPSArtifact.abi,
    functionName: "initialize",
    args: ["0x0000000000000000000000000000000000000000" as `0x${string}`],
  });
  const identityProxyBytecode = await getProxyBytecode(minimalUUPS.address, identityInitData);
  const identityProxy = await deployBytecode(
    deployer,
    publicClient,
    identityProxyBytecode,
    "IdentityRegistry proxy"
  );
  console.log(`   ✅ Deployed at: ${identityProxy.address}`);
  console.log(`   Tx: ${identityProxy.txHash}`);
  console.log("");

  console.log("3. Deploying ReputationRegistry proxy...");
  const reputationInitData = encodeFunctionData({
    abi: minimalUUPSArtifact.abi,
    functionName: "initialize",
    args: [identityProxy.address],
  });
  const reputationProxyBytecode = await getProxyBytecode(minimalUUPS.address, reputationInitData);
  const reputationProxy = await deployBytecode(
    deployer,
    publicClient,
    reputationProxyBytecode,
    "ReputationRegistry proxy"
  );
  console.log(`   ✅ Deployed at: ${reputationProxy.address}`);
  console.log(`   Tx: ${reputationProxy.txHash}`);
  console.log("");

  console.log("4. Deploying ValidationRegistry proxy...");
  const validationInitData = encodeFunctionData({
    abi: minimalUUPSArtifact.abi,
    functionName: "initialize",
    args: [identityProxy.address],
  });
  const validationProxyBytecode = await getProxyBytecode(minimalUUPS.address, validationInitData);
  const validationProxy = await deployBytecode(
    deployer,
    publicClient,
    validationProxyBytecode,
    "ValidationRegistry proxy"
  );
  console.log(`   ✅ Deployed at: ${validationProxy.address}`);
  console.log(`   Tx: ${validationProxy.txHash}`);
  console.log("");

  console.log("PHASE 3: Deploying Implementation Contracts (CREATE)");
  console.log("=====================================================");
  console.log("");

  console.log("5. Deploying IdentityRegistry implementation...");
  const identityImpl = await deployBytecode(
    deployer,
    publicClient,
    identityImplArtifact.bytecode as Hex,
    "IdentityRegistryUpgradeable"
  );
  console.log(`   ✅ Deployed at: ${identityImpl.address}`);
  console.log(`   Tx: ${identityImpl.txHash}`);
  console.log("");

  console.log("6. Deploying ReputationRegistry implementation...");
  const reputationImpl = await deployBytecode(
    deployer,
    publicClient,
    reputationImplArtifact.bytecode as Hex,
    "ReputationRegistryUpgradeable"
  );
  console.log(`   ✅ Deployed at: ${reputationImpl.address}`);
  console.log(`   Tx: ${reputationImpl.txHash}`);
  console.log("");

  console.log("7. Deploying ValidationRegistry implementation...");
  const validationImpl = await deployBytecode(
    deployer,
    publicClient,
    validationImplArtifact.bytecode as Hex,
    "ValidationRegistryUpgradeable"
  );
  console.log(`   ✅ Deployed at: ${validationImpl.address}`);
  console.log(`   Tx: ${validationImpl.txHash}`);
  console.log("");

  const output = {
    mode: "random-create",
    chainId,
    networkName: networkName ?? hre.network.name,
    networkType,
    deployer: deployer.account.address,
    timestamp: new Date().toISOString(),
    minimalUUPS: {
      contract: minimalUUPSContract,
      address: minimalUUPS.address,
      txHash: minimalUUPS.txHash,
    },
    proxies: {
      identityRegistry: identityProxy.address,
      reputationRegistry: reputationProxy.address,
      validationRegistry: validationProxy.address,
    },
    implementations: {
      identityRegistry: identityImpl.address,
      reputationRegistry: reputationImpl.address,
      validationRegistry: validationImpl.address,
    },
    transactions: {
      minimalUUPS: minimalUUPS.txHash,
      identityRegistryImplementation: identityImpl.txHash,
      reputationRegistryImplementation: reputationImpl.txHash,
      validationRegistryImplementation: validationImpl.txHash,
      identityRegistryProxy: identityProxy.txHash,
      reputationRegistryProxy: reputationProxy.txHash,
      validationRegistryProxy: validationProxy.txHash,
    },
  };

  const outputPath = `deploy-rand-chain-${chainId}.json`;
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log("=".repeat(80));
  console.log("DEPLOYMENT COMPLETE");
  console.log("=".repeat(80));
  console.log("");
  console.log("✅ Random deployment completed (no CREATE2 factory)");
  console.log(`✅ Proxies are initialized with ${minimalUUPSContract} (owner is set)`);
  console.log("✅ Deployment record written to:", outputPath);
  console.log("");
  console.log("Proxy Addresses:");
  console.log("  IdentityRegistry:    ", identityProxy.address);
  console.log("  ReputationRegistry:  ", reputationProxy.address);
  console.log("  ValidationRegistry:  ", validationProxy.address);
  console.log("");
  console.log("Implementation Addresses:");
  console.log("  IdentityRegistry:    ", identityImpl.address);
  console.log("  ReputationRegistry:  ", reputationImpl.address);
  console.log("  ValidationRegistry:  ", validationImpl.address);

  return output;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
