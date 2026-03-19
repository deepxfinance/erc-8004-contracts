import hre from "hardhat";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { customChains } from "./custom-chains";
import dotenv from "dotenv";
import { EXPECTED_OWNER, getMinimalUUPSContract, getNetworkType } from "./addresses";
import {
  Address,
  TxHash,
  assertRecordedAddress,
  createEmptyDeployment,
  ensureCodeExists,
  getDeploymentOutputPath,
  loadDeployment,
  printDeploymentSummary,
  saveDeployment,
  toPkEnvVar,
  with0x,
} from "./deployment";

dotenv.config();

async function getProxyBytecode(
  implementationAddress: Address,
  initCalldata: Hex
): Promise<Hex> {
  const proxyArtifact = await hre.artifacts.readArtifact("ERC1967Proxy");

  const constructorArgs = encodeAbiParameters(
    [
      { name: "implementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    [implementationAddress, initCalldata]
  );

  return (proxyArtifact.bytecode + constructorArgs.slice(2)) as Hex;
}

async function deployBytecode(
  deployer: any,
  publicClient: any,
  bytecode: Hex,
  label: string
): Promise<{ address: Address; txHash: TxHash }> {
  const txHash = await deployer.sendTransaction({ data: bytecode });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const address = receipt.contractAddress as Address | undefined;

  if (!address || receipt.status !== "success") {
    throw new Error(`${label} deployment failed: contractAddress missing in receipt (${txHash})`);
  }

  return { address, txHash };
}

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
    const currentNetworkName = networkName ?? "unknown";
    console.error("");
    console.error("❌ ERROR: No wallet configured for this network.");
    console.error("");
    console.error("   Please ensure a private key is configured for the selected network.");
    console.error(`   Example variable: ${currentNetworkName.toUpperCase().replace(/-/g, "_")}_PRIVATE_KEY`);
    console.error("");
    process.exit(1);
  }

  const chainId = await publicClient.getChainId();
  const resolvedNetworkName = networkName ?? "hardhat";
  const networkType = getNetworkType(chainId);
  const minimalUUPSContract = getMinimalUUPSContract(chainId);
  const outputPath = getDeploymentOutputPath(chainId);

  let deployment = loadDeployment(outputPath);
  if (!deployment) {
    deployment = createEmptyDeployment(
      chainId,
      resolvedNetworkName,
      networkType,
      deployer.account.address as Address,
      minimalUUPSContract
    );
  } else {
    if (deployment.chainId !== chainId) {
      throw new Error(`Deployment record chainId mismatch: expected ${chainId}, found ${deployment.chainId}`);
    }
    console.log(`⚠️  Found existing deployment file: ${outputPath}`);
    console.log("Resuming and verifying recorded random deployment.");
    console.log("");
  }

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

  if (deployment.status.deployed) {
    assertRecordedAddress(deployment.minimalUUPS.address, "MinimalUUPS");
    assertRecordedAddress(deployment.proxies.identityRegistry, "IdentityRegistry proxy");
    assertRecordedAddress(deployment.proxies.reputationRegistry, "ReputationRegistry proxy");
    assertRecordedAddress(deployment.proxies.validationRegistry, "ValidationRegistry proxy");
    assertRecordedAddress(deployment.implementations.identityRegistry, "IdentityRegistry implementation");
    assertRecordedAddress(deployment.implementations.reputationRegistry, "ReputationRegistry implementation");
    assertRecordedAddress(deployment.implementations.validationRegistry, "ValidationRegistry implementation");

    await ensureCodeExists(publicClient, deployment.minimalUUPS.address, `${minimalUUPSContract} placeholder`);
    await ensureCodeExists(publicClient, deployment.proxies.identityRegistry, "IdentityRegistry proxy");
    await ensureCodeExists(publicClient, deployment.proxies.reputationRegistry, "ReputationRegistry proxy");
    await ensureCodeExists(publicClient, deployment.proxies.validationRegistry, "ValidationRegistry proxy");
    await ensureCodeExists(publicClient, deployment.implementations.identityRegistry, "IdentityRegistry implementation");
    await ensureCodeExists(publicClient, deployment.implementations.reputationRegistry, "ReputationRegistry implementation");
    await ensureCodeExists(publicClient, deployment.implementations.validationRegistry, "ValidationRegistry implementation");

    console.log("Existing random deployment found on-chain. Skipping CREATE phase.");
    console.log("");
  } else {
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
    deployment.minimalUUPS = {
      contract: minimalUUPSContract,
      address: minimalUUPS.address,
      txHash: minimalUUPS.txHash,
    };
    deployment.transactions.minimalUUPS = minimalUUPS.txHash;
    saveDeployment(outputPath, deployment);
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
      args: ["0x0000000000000000000000000000000000000000" as Address],
    });
    const identityProxyBytecode = await getProxyBytecode(minimalUUPS.address, identityInitData);
    const identityProxy = await deployBytecode(deployer, publicClient, identityProxyBytecode, "IdentityRegistry proxy");
    deployment.proxies.identityRegistry = identityProxy.address;
    deployment.transactions.identityRegistryProxy = identityProxy.txHash;
    saveDeployment(outputPath, deployment);
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
    const reputationProxy = await deployBytecode(deployer, publicClient, reputationProxyBytecode, "ReputationRegistry proxy");
    deployment.proxies.reputationRegistry = reputationProxy.address;
    deployment.transactions.reputationRegistryProxy = reputationProxy.txHash;
    saveDeployment(outputPath, deployment);
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
    const validationProxy = await deployBytecode(deployer, publicClient, validationProxyBytecode, "ValidationRegistry proxy");
    deployment.proxies.validationRegistry = validationProxy.address;
    deployment.transactions.validationRegistryProxy = validationProxy.txHash;
    saveDeployment(outputPath, deployment);
    console.log(`   ✅ Deployed at: ${validationProxy.address}`);
    console.log(`   Tx: ${validationProxy.txHash}`);
    console.log("");

    console.log("PHASE 3: Deploying Implementation Contracts (CREATE)");
    console.log("=====================================================");
    console.log("");

    console.log("5. Deploying IdentityRegistry implementation...");
    const identityImpl = await deployBytecode(deployer, publicClient, identityImplArtifact.bytecode as Hex, "IdentityRegistryUpgradeable");
    deployment.implementations.identityRegistry = identityImpl.address;
    deployment.transactions.identityRegistryImplementation = identityImpl.txHash;
    saveDeployment(outputPath, deployment);
    console.log(`   ✅ Deployed at: ${identityImpl.address}`);
    console.log(`   Tx: ${identityImpl.txHash}`);
    console.log("");

    console.log("6. Deploying ReputationRegistry implementation...");
    const reputationImpl = await deployBytecode(deployer, publicClient, reputationImplArtifact.bytecode as Hex, "ReputationRegistryUpgradeable");
    deployment.implementations.reputationRegistry = reputationImpl.address;
    deployment.transactions.reputationRegistryImplementation = reputationImpl.txHash;
    saveDeployment(outputPath, deployment);
    console.log(`   ✅ Deployed at: ${reputationImpl.address}`);
    console.log(`   Tx: ${reputationImpl.txHash}`);
    console.log("");

    console.log("7. Deploying ValidationRegistry implementation...");
    const validationImpl = await deployBytecode(deployer, publicClient, validationImplArtifact.bytecode as Hex, "ValidationRegistryUpgradeable");
    deployment.implementations.validationRegistry = validationImpl.address;
    deployment.transactions.validationRegistryImplementation = validationImpl.txHash;
    deployment.status.deployed = true;
    deployment.status.upgraded = false;
    deployment.status.verified = false;
    saveDeployment(outputPath, deployment);
    console.log(`   ✅ Deployed at: ${validationImpl.address}`);
    console.log(`   Tx: ${validationImpl.txHash}`);
    console.log("");
  }

  console.log("✅ Random deployment completed (deploy phase only)");
  console.log(`✅ Proxies are initialized with ${minimalUUPSContract} (owner is set)`);
  console.log(`✅ Deployment record written to: ${outputPath}`);
  console.log("");
  printDeploymentSummary(deployment, outputPath, EXPECTED_OWNER);

  console.log("NEXT STEPS:");
  console.log("  1) npx hardhat run scripts/upgrade-rand.ts --network <network>");
  console.log("  2) npx hardhat run scripts/verify-rand.ts --network <network>");
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
