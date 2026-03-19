import { execSync } from "child_process";
import hre from "hardhat";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  Hex,
  http,
  keccak256,
  serializeTransaction,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { customChains } from "./custom-chains";
import dotenv from "dotenv";
import { EXPECTED_OWNER } from "./addresses";
import {
  Address,
  LOCAL_TOP_UP,
  RandomDeploymentRecord,
  assertRecordedAddress,
  ensureCodeExists,
  getCurrentImplementation,
  getDeploymentOutputPath,
  isLocalNetwork,
  loadDeploymentOrThrow,
  saveDeployment,
  with0x,
} from "./deployment";

dotenv.config();

async function resolveOwnerWallet(params: {
  deployer: any;
  publicClient: any;
  custom: any;
}): Promise<{ ownerWallet: any; ownerAddress: Address; mode: string }> {
  const { deployer, publicClient, custom } = params;

  if ((deployer.account.address as Address).toLowerCase() === EXPECTED_OWNER.toLowerCase()) {
    return {
      ownerWallet: deployer,
      ownerAddress: deployer.account.address as Address,
      mode: "deployer",
    };
  }

  let ownerAccount: any;
  let mode = "hsm";
  const ownerPrivateKey = process.env.OWNER_PRIVATE_KEY;

  if (ownerPrivateKey) {
    mode = "env";
    const normalized = with0x(ownerPrivateKey);
    if (normalized.length !== 66 || !/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
      throw new Error("Invalid OWNER_PRIVATE_KEY format. Expected 0x followed by 64 hex characters.");
    }
    ownerAccount = privateKeyToAccount(normalized);
  } else {
    function hsm(cmd: string): string {
      for (let i = 0; i < 3; i++) {
        try {
          return execSync(`hsm ${cmd}`, { timeout: 5000 }).toString().trim();
        } catch {
          if (i === 2) throw new Error(`hsm ${cmd} failed after 3 retries`);
          execSync("sleep 1");
        }
      }
      throw new Error("unreachable");
    }

    const info = JSON.parse(hsm("addr")) as { address: Address };

    ownerAccount = toAccount({
      address: info.address,
      async signMessage({ message }) {
        const msg = typeof message === "string"
          ? new TextEncoder().encode(message)
          : "raw" in message
            ? message.raw
            : message;
        const hash = keccak256(msg);
        const raw = hash.startsWith("0x") ? hash.slice(2) : hash;
        const result = JSON.parse(hsm(`sign ${raw}`)) as { r: Hex; s: Hex; v: number };
        return `${result.r}${result.s.slice(2)}${(result.v - 27).toString(16).padStart(2, "0")}` as Hex;
      },
      async signTransaction(tx, { serializer = serializeTransaction } = {}) {
        const serialized = await serializer(tx);
        const hash = keccak256(serialized);
        const raw = hash.startsWith("0x") ? hash.slice(2) : hash;
        const result = JSON.parse(hsm(`sign ${raw}`)) as { r: Hex; s: Hex; v: number };
        return serializer(tx, { r: result.r, s: result.s, v: BigInt(result.v) });
      },
      async signTypedData() {
        throw new Error("signTypedData not implemented");
      },
    });
  }

  const ownerAddress = ownerAccount.address as Address;
  if (ownerAddress.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
    throw new Error(
      `Owner signer mismatch. Expected ${EXPECTED_OWNER}, got ${ownerAddress}. ` +
      `MinimalUUPS hardcodes the owner, so upgrades must be signed by the expected owner.`
    );
  }

  const ownerWallet = custom
    ? createWalletClient({
        account: ownerAccount,
        chain: custom,
        transport: http(custom.rpcUrls.default.http[0]),
      })
    : createWalletClient({
        account: ownerAccount,
        chain: publicClient.chain,
        transport: http(),
      });

  return { ownerWallet, ownerAddress, mode };
}

async function maybeFundLocalOwner(params: {
  deployer: any;
  publicClient: any;
  ownerAddress: Address;
  networkName: string;
  chainId: number;
  deployment: RandomDeploymentRecord;
  outputPath: string;
}) {
  const { deployer, publicClient, ownerAddress, networkName, chainId, deployment, outputPath } = params;

  if ((deployer.account.address as Address).toLowerCase() === ownerAddress.toLowerCase()) {
    return;
  }

  if (!isLocalNetwork(networkName, chainId)) {
    return;
  }

  const balance = await publicClient.getBalance({ address: ownerAddress });
  if (balance >= LOCAL_TOP_UP) {
    return;
  }

  console.log("Funding owner address for local upgrade gas...");
  const fundingTxHash = await deployer.sendTransaction({
    to: ownerAddress,
    value: LOCAL_TOP_UP - balance,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: fundingTxHash });
  if (receipt.status !== "success") {
    throw new Error(`Owner funding failed: ${fundingTxHash}`);
  }

  deployment.transactions.ownerFunding = fundingTxHash;
  saveDeployment(outputPath, deployment);
  console.log(`   ✅ Owner funded via ${fundingTxHash}`);
}

async function main() {
  const networkIdx = process.argv.indexOf("--network");
  const networkName = networkIdx !== -1 ? process.argv[networkIdx + 1] : undefined;
  const custom = networkName ? customChains[networkName] : undefined;

  let publicClient: any;
  let deployer: any;

  if (custom) {
    const rpcUrl = custom.rpcUrls.default.http[0];
    const pkEnv = `${networkName!.replace(/([A-Z])/g, "_$1").toUpperCase()}_PRIVATE_KEY`;
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
    throw new Error("No wallet configured for this network.");
  }

  const chainId = await publicClient.getChainId();
  const resolvedNetworkName = networkName ?? "hardhat";
  const outputPath = getDeploymentOutputPath(chainId);
  const deployment = loadDeploymentOrThrow(outputPath);

  if (deployment.mode !== "random-create") {
    throw new Error(`Unsupported deployment mode: ${deployment.mode}`);
  }
  if (!deployment.status.deployed) {
    throw new Error("Deployment is not complete. Run scripts/deploy-rand.ts first.");
  }

  assertRecordedAddress(deployment.minimalUUPS.address, "MinimalUUPS");
  assertRecordedAddress(deployment.proxies.identityRegistry, "IdentityRegistry proxy");
  assertRecordedAddress(deployment.proxies.reputationRegistry, "ReputationRegistry proxy");
  assertRecordedAddress(deployment.proxies.validationRegistry, "ValidationRegistry proxy");
  assertRecordedAddress(deployment.implementations.identityRegistry, "IdentityRegistry implementation");
  assertRecordedAddress(deployment.implementations.reputationRegistry, "ReputationRegistry implementation");
  assertRecordedAddress(deployment.implementations.validationRegistry, "ValidationRegistry implementation");

  await ensureCodeExists(publicClient, deployment.minimalUUPS.address, `${deployment.minimalUUPS.contract} placeholder`);
  await ensureCodeExists(publicClient, deployment.proxies.identityRegistry, "IdentityRegistry proxy");
  await ensureCodeExists(publicClient, deployment.proxies.reputationRegistry, "ReputationRegistry proxy");
  await ensureCodeExists(publicClient, deployment.proxies.validationRegistry, "ValidationRegistry proxy");
  await ensureCodeExists(publicClient, deployment.implementations.identityRegistry, "IdentityRegistry implementation");
  await ensureCodeExists(publicClient, deployment.implementations.reputationRegistry, "ReputationRegistry implementation");
  await ensureCodeExists(publicClient, deployment.implementations.validationRegistry, "ValidationRegistry implementation");

  const minimalUUPSArtifact = await hre.artifacts.readArtifact(deployment.minimalUUPS.contract);
  const identityImplArtifact = await hre.artifacts.readArtifact("IdentityRegistryUpgradeable");
  const reputationImplArtifact = await hre.artifacts.readArtifact("ReputationRegistryUpgradeable");
  const validationImplArtifact = await hre.artifacts.readArtifact("ValidationRegistryUpgradeable");

  const { ownerWallet, ownerAddress, mode: ownerMode } = await resolveOwnerWallet({
    deployer,
    publicClient,
    custom,
  });

  deployment.owner = ownerAddress;
  saveDeployment(outputPath, deployment);

  console.log("Upgrading ERC-8004 Random Proxies");
  console.log("=================================");
  console.log("Chain ID:", chainId);
  console.log("Owner signer:", ownerAddress, `(${ownerMode})`);
  console.log("");

  await maybeFundLocalOwner({
    deployer,
    publicClient,
    ownerAddress,
    networkName: resolvedNetworkName,
    chainId,
    deployment,
    outputPath,
  });

  const upgradeTargets = [
    {
      name: "IdentityRegistry",
      proxy: deployment.proxies.identityRegistry,
      implementation: deployment.implementations.identityRegistry,
      initData: encodeFunctionData({
        abi: identityImplArtifact.abi,
        functionName: "initialize",
        args: [],
      }),
      txField: "identityRegistryUpgrade" as const,
    },
    {
      name: "ReputationRegistry",
      proxy: deployment.proxies.reputationRegistry,
      implementation: deployment.implementations.reputationRegistry,
      initData: encodeFunctionData({
        abi: reputationImplArtifact.abi,
        functionName: "initialize",
        args: [deployment.proxies.identityRegistry],
      }),
      txField: "reputationRegistryUpgrade" as const,
    },
    {
      name: "ValidationRegistry",
      proxy: deployment.proxies.validationRegistry,
      implementation: deployment.implementations.validationRegistry,
      initData: encodeFunctionData({
        abi: validationImplArtifact.abi,
        functionName: "initialize",
        args: [deployment.proxies.identityRegistry],
      }),
      txField: "validationRegistryUpgrade" as const,
    },
  ];

  for (const target of upgradeTargets) {
    const currentImplementation = await getCurrentImplementation(publicClient, target.proxy);

    console.log(`Checking ${target.name} proxy...`);
    console.log(`   Proxy: ${target.proxy}`);
    console.log(`   Current implementation: ${currentImplementation ?? "<unset>"}`);
    console.log(`   Target implementation:  ${target.implementation}`);

    if (currentImplementation?.toLowerCase() === target.implementation.toLowerCase()) {
      console.log("   ⏭️  Already upgraded");
      console.log("");
      continue;
    }

    const upgradeData = encodeFunctionData({
      abi: minimalUUPSArtifact.abi,
      functionName: "upgradeToAndCall",
      args: [target.implementation, target.initData],
    });

    const upgradeTxHash = await ownerWallet.sendTransaction({
      to: target.proxy,
      data: upgradeData,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: upgradeTxHash });
    if (receipt.status !== "success") {
      throw new Error(`${target.name} upgrade failed: ${upgradeTxHash}`);
    }

    deployment.transactions[target.txField] = upgradeTxHash;
    saveDeployment(outputPath, deployment);
    console.log(`   ✅ Upgraded in tx: ${upgradeTxHash}`);
    console.log("");
  }

  deployment.status.upgraded = true;
  deployment.status.verified = false;
  saveDeployment(outputPath, deployment);

  console.log("✅ Upgrade phase completed");
  console.log(`✅ Deployment record updated: ${outputPath}`);
  console.log("Next: npx hardhat run scripts/verify-rand.ts --network <network>");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
