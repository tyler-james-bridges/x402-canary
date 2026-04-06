export interface Endpoint {
  name: string;
  url: string;
  description: string;
}

export const endpoints: Endpoint[] = [
  {
    name: "x402.org",
    url: "https://x402.org",
    description: "x402 protocol homepage and reference implementation",
  },
  {
    name: "Coinbase Developer Platform",
    url: "https://api.developer.coinbase.com/rpc/v1/base/health",
    description: "Coinbase CDP RPC endpoint (Base mainnet)",
  },
  {
    name: "Base Mainnet RPC",
    url: "https://mainnet.base.org",
    description: "Base network public RPC endpoint",
  },
  {
    name: "Abstract RPC",
    url: "https://api.mainnet.abs.xyz",
    description: "Abstract chain public RPC endpoint",
  },
  {
    name: "agentcash.dev",
    url: "https://agentcash.dev",
    description: "AgentCash x402 micropayment gateway",
  },
];
