import fs from "fs";
import path from "path";

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;

export type DeploymentContracts = {
  identityRegistry: Address;
  reputationRegistry: Address;
  validationRegistry: Address;
};

export type DeploymentTransactions = {
  minimalUUPS?: TxHash;
  identityRegistryImplementation?: TxHash;
  reputationRegistryImplementation?: TxHash;
  validationRegistryImplementation?: TxHash;
  identityRegistryProxy?: TxHash;
  reputationRegistryProxy?: TxHash;
  validationRegistryProxy?: TxHash;
  identityRegistryUpgrade?: TxHash;
  reputationRegistryUpgrade?: TxHash;
  validationRegistryUpgrade?: TxHash;
  ownerFunding?: TxHash;
};

export type DeploymentStatus = {
  deployed: boolean;
  upgraded: boolean;
  verified: boolean;
};

export type RandomDeploymentRecord = {
  mode: "random-create";
  chainId: number;
  networkName: string;
  networkType: "mainnet" | "testnet";
  deployer: Address;
  owner?: Address;
  timestamp: string;
  minimalUUPS: {
    contract: string;
    address: Address;
    txHash?: TxHash;
  };
  proxies: DeploymentContracts;
  implementations: DeploymentContracts;
  transactions: DeploymentTransactions;
  status: DeploymentStatus;
};

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
export const LOCAL_TOP_UP = 10_000_000_000_000_000n;

export function toPkEnvVar(networkName: string): string {
  return `${networkName.replace(/([A-Z])/g, "_$1").toUpperCase()}_PRIVATE_KEY`;
}

export function with0x(value: string): Address {
  return (value.startsWith("0x") ? value : `0x${value}`) as Address;
}

export function isLocalNetwork(networkName: string, chainId: number): boolean {
  return chainId === 31337 || networkName === "localhost" || networkName === "hardhat";
}

export function getDeploymentOutputPath(chainId: number): string {
  return path.join(process.cwd(), "deployments", `chain-${chainId}.json`);
}

export function printDeploymentSummary(
  deployment: RandomDeploymentRecord,
  outputPath: string,
  expectedOwner: Address
) {
  console.log("=".repeat(80));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(80));
  console.log("");
  console.log("Deployment record:", outputPath);
  console.log("Mode:", deployment.mode);
  console.log("Chain ID:", deployment.chainId);
  console.log("Network:", deployment.networkName);
  console.log("Deployer:", deployment.deployer);
  console.log("Owner:", deployment.owner ?? expectedOwner);
  console.log("Deployed:", deployment.status.deployed ? "yes" : "no");
  console.log("Upgraded:", deployment.status.upgraded ? "yes" : "no");
  console.log("Verified:", deployment.status.verified ? "yes" : "no");
  console.log("");
  console.log("Proxy Addresses:");
  console.log("  IdentityRegistry:    ", deployment.proxies.identityRegistry);
  console.log("  ReputationRegistry:  ", deployment.proxies.reputationRegistry);
  console.log("  ValidationRegistry:  ", deployment.proxies.validationRegistry);
  console.log("");
  console.log("Implementation Addresses:");
  console.log("  IdentityRegistry:    ", deployment.implementations.identityRegistry);
  console.log("  ReputationRegistry:  ", deployment.implementations.reputationRegistry);
  console.log("  ValidationRegistry:  ", deployment.implementations.validationRegistry);
  console.log("");
}

export function createEmptyDeployment(
  chainId: number,
  networkName: string,
  networkType: "mainnet" | "testnet",
  deployer: Address,
  minimalUUPSContract: string
): RandomDeploymentRecord {
  return {
    mode: "random-create",
    chainId,
    networkName,
    networkType,
    deployer,
    timestamp: new Date().toISOString(),
    minimalUUPS: {
      contract: minimalUUPSContract,
      address: ZERO_ADDRESS,
    },
    proxies: {
      identityRegistry: ZERO_ADDRESS,
      reputationRegistry: ZERO_ADDRESS,
      validationRegistry: ZERO_ADDRESS,
    },
    implementations: {
      identityRegistry: ZERO_ADDRESS,
      reputationRegistry: ZERO_ADDRESS,
      validationRegistry: ZERO_ADDRESS,
    },
    transactions: {},
    status: {
      deployed: false,
      upgraded: false,
      verified: false,
    },
  };
}

export function loadDeployment(outputPath: string): RandomDeploymentRecord | null {
  if (!fs.existsSync(outputPath)) {
    return null;
  }

  const raw = fs.readFileSync(outputPath, "utf-8");
  return JSON.parse(raw) as RandomDeploymentRecord;
}

export function loadDeploymentOrThrow(outputPath: string): RandomDeploymentRecord {
  const deployment = loadDeployment(outputPath);
  if (!deployment) {
    throw new Error(`Deployment record not found: ${outputPath}. Run scripts/deploy-rand.ts first.`);
  }
  return deployment;
}

export function saveDeployment(outputPath: string, deployment: RandomDeploymentRecord) {
  deployment.timestamp = new Date().toISOString();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2));
}

export function assertRecordedAddress(address: string | undefined, label: string): asserts address is Address {
  if (!address || address === ZERO_ADDRESS) {
    throw new Error(`${label} missing from deployment record. Re-run scripts/deploy-rand.ts.`);
  }
}

export async function ensureCodeExists(publicClient: any, address: Address, label: string): Promise<void> {
  const code = await publicClient.getBytecode({ address });
  if (!code || code === "0x") {
    throw new Error(`${label} is missing on-chain at ${address}.`);
  }
}

export async function getCurrentImplementation(publicClient: any, proxyAddress: Address): Promise<Address | null> {
  const impl = await publicClient.getStorageAt({
    address: proxyAddress,
    slot: IMPLEMENTATION_SLOT,
  });

  if (!impl || impl === "0x") {
    return null;
  }

  return `0x${impl.slice(-40)}` as Address;
}
