export interface Endpoint {
  name: string;
  url: string;
  method: string;
  description: string;
  expectedPrice?: string;
}

export const endpoints: Endpoint[] = [
  // x402scan - payment data explorer
  {
    name: "x402scan Merchants",
    url: "https://www.x402scan.com/api/x402/merchants",
    method: "GET",
    description: "Paginated list of merchants by volume",
    expectedPrice: "$0.01",
  },
  {
    name: "x402scan Resources",
    url: "https://www.x402scan.com/api/x402/resources",
    method: "GET",
    description: "All indexed x402 resources",
    expectedPrice: "$0.01",
  },
  {
    name: "x402scan Facilitators",
    url: "https://www.x402scan.com/api/x402/facilitators",
    method: "GET",
    description: "x402 facilitators with stats",
    expectedPrice: "$0.01",
  },
  // StableEnrich - pay-per-request API access
  {
    name: "StableEnrich Exa Search",
    url: "https://stableenrich.dev/api/exa/search",
    method: "POST",
    description: "Neural search across the web via Exa",
    expectedPrice: "$0.01",
  },
  {
    name: "StableEnrich Firecrawl Scrape",
    url: "https://stableenrich.dev/api/firecrawl/scrape",
    method: "POST",
    description: "Scrape URLs with JS rendering",
    expectedPrice: "$0.0126",
  },
  {
    name: "StableEnrich Apollo People",
    url: "https://stableenrich.dev/api/apollo/people-search",
    method: "POST",
    description: "Apollo people search API",
    expectedPrice: "$0.02",
  },
  // AgentCash
  {
    name: "AgentCash Send",
    url: "https://agentcash.dev/api/send",
    method: "POST",
    description: "Send USDC on Base/Solana",
    expectedPrice: "dynamic",
  },
  // Infrastructure health
  {
    name: "Base RPC",
    url: "https://mainnet.base.org",
    method: "POST",
    description: "Base L2 mainnet RPC",
    expectedPrice: "free",
  },
];
