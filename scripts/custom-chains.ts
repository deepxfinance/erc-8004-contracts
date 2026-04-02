import { defineChain } from "viem";

/**
 * Custom chain definitions for chains not yet in viem's built-in list.
 * Key must match the network name in hardhat.config.ts.
 */
export const customChains: Record<string, ReturnType<typeof defineChain>> = {
  xlayerTestnet: defineChain({
    id: 1952,
    name: "XLayer Testnet",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
  }),
  goatTestnet: defineChain({
    id: 48816,
    name: "GOAT Testnet3",
    nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.testnet3.goat.network"] } },
  }),
  skaleBaseSepolia: defineChain({
    id: 324705682,
    name: "SKALE Base Sepolia",
    nativeCurrency: { name: "Credits", symbol: "CREDIT", decimals: 18 },
    rpcUrls: { default: { http: ["https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha"] } },
  }),
  skaleBase: defineChain({
    id: 1187947933,
    name: "SKALE Base",
    nativeCurrency: { name: "Credits", symbol: "CREDIT", decimals: 18 },
    rpcUrls: { default: { http: ["https://skale-base.skalenodes.com/v1/base"] } },
  }),
  arcTestnet: defineChain({
    id: 5042002,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  }),
  boolTestnet: defineChain({
    id: 481,
    name: "Bool Testnet",
    nativeCurrency: { name: "BOL", symbol: "BOL", decimals: 18 },
    rpcUrls: { default: { http: ["https://betatest-rpc-node-ws.bool.network"] } },
  }),
  deepxDevnet: defineChain({
    id: 4835,
    name: "DeepX Devnet",
    nativeCurrency: { name: "DEX", symbol: "DEX", decimals: 18 },
    rpcUrls: { default: { http: ["https://devnet-rpc.deepx.fi"] } },
  }),
  deepxBetaDevnet: defineChain({
    id: 4845,
    name: "DeepX Beta Devnet",
    nativeCurrency: { name: "DEX", symbol: "DEX", decimals: 18 },
    rpcUrls: { default: { http: ["https://devnet-rpc-new.deepx.fi"] } },
  }),
};
