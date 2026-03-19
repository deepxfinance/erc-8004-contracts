import hre from "hardhat";
import { createPublicClient, http } from "viem";
import { customChains } from "./custom-chains";
import dotenv from "dotenv";
import {
  assertRecordedAddress,
  ensureCodeExists,
  getCurrentImplementation,
  getDeploymentOutputPath,
  loadDeploymentOrThrow,
  saveDeployment,
} from "./deployment";

dotenv.config();

async function main() {
  const networkIdx = process.argv.indexOf("--network");
  const networkName = networkIdx !== -1 ? process.argv[networkIdx + 1] : undefined;
  const custom = networkName ? customChains[networkName] : undefined;

  let publicClient: any;

  if (custom) {
    const rpcUrl = custom.rpcUrls.default.http[0];
    publicClient = createPublicClient({ chain: custom, transport: http(rpcUrl) });
  } else {
    const { viem } = await hre.network.connect();
    publicClient = await viem.getPublicClient();
  }

  const chainId = await publicClient.getChainId();
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

  console.log("Verifying ERC-8004 Random Proxies");
  console.log("===============================");
  console.log("Chain ID:", chainId);
  console.log("");

  const checks = [
    {
      name: "IdentityRegistry",
      proxy: deployment.proxies.identityRegistry,
      expected: deployment.implementations.identityRegistry,
    },
    {
      name: "ReputationRegistry",
      proxy: deployment.proxies.reputationRegistry,
      expected: deployment.implementations.reputationRegistry,
    },
    {
      name: "ValidationRegistry",
      proxy: deployment.proxies.validationRegistry,
      expected: deployment.implementations.validationRegistry,
    },
  ];

  for (const check of checks) {
    const current = await getCurrentImplementation(publicClient, check.proxy);

    console.log(`${check.name}:`);
    console.log(`  Proxy: ${check.proxy}`);
    console.log(`  Current implementation: ${current ?? "<unset>"}`);
    console.log(`  Expected implementation: ${check.expected}`);

    if (current?.toLowerCase() !== check.expected.toLowerCase()) {
      deployment.status.verified = false;
      saveDeployment(outputPath, deployment);
      throw new Error(
        `${check.name} implementation mismatch. Expected ${check.expected}, found ${current ?? "<unset>"}.`
      );
    }

    console.log("  Status: ✅ VERIFIED");
    console.log("");
  }

  deployment.status.upgraded = true;
  deployment.status.verified = true;
  saveDeployment(outputPath, deployment);

  console.log("✅ Verification completed");
  console.log(`✅ Deployment record updated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
