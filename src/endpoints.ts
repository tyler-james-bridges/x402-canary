export interface Endpoint {
  name: string;
  url: string;
  method: string;
  description: string;
  expectedPrice?: string;
}

export const endpoints: Endpoint[] = [
  // Bankr x402 Cloud — TJB
  {
    name: "Bankr x402 Lint",
    url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint",
    method: "POST",
    description: "x402 compliance linter via Bankr Cloud",
    expectedPrice: "$0.01",
  },
  {
    name: "Bankr x402 Health",
    url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/health",
    method: "POST",
    description: "Quick x402 health check via Bankr Cloud",
    expectedPrice: "$0.001",
  },
  // Bankr x402 Cloud — LITCOIN
  {
    name: "LITCOIN Chat",
    url: "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/chat",
    method: "POST",
    description: "OpenAI-compatible LLM inference via x402",
    expectedPrice: "$0.001",
  },
  {
    name: "LITCOIN Compute",
    url: "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/compute",
    method: "POST",
    description: "AI inference with pay-per-request, no API keys",
    expectedPrice: "$0.001",
  },
  // Bankr x402 Cloud — buzzbd.ai
  {
    name: "DeFi Yield Compare",
    url: "https://x402.bankr.bot/0xfa04c7d627ba707a1ad17e72e094b45150665593/yield-compare",
    method: "GET",
    description: "Best DeFi yields across 51 protocols ranked by APY",
    expectedPrice: "$0.01",
  },
  // Bankr x402 Cloud — market data
  {
    name: "Trending Base Coins",
    url: "https://x402.bankr.bot/0xf47535adb19c8905f9384e423063708651ac2805/trending-base-coins",
    method: "GET",
    description: "Trending tokens on Base with price and volume data",
    expectedPrice: "$0.001",
  },
  // Bankr x402 Cloud — ecological data
  {
    name: "Regen Oracle",
    url: "https://x402.bankr.bot/0x538aa4800ae2bd8e90556899514376ab96113a8e/regen-oracle",
    method: "POST",
    description: "Live ecological credit data from Regen Ledger",
    expectedPrice: "$0.005",
  },
  // x402scan — payment data explorer
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
  // StableEnrich — pay-per-request API access
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
  // Infrastructure
  {
    name: "Base RPC",
    url: "https://mainnet.base.org",
    method: "POST",
    description: "Base L2 mainnet RPC",
    expectedPrice: "free",
  },
  // Other x402 services
  {
    name: "Giga API",
    url: "https://stableclaude.dev/api/start",
    method: "POST",
    description: "Pay-per-run AI agent execution",
    expectedPrice: "dynamic",
  },
  {
    name: "dTelecom x402",
    url: "https://x402.dtelecom.org/v1/credits/purchase",
    method: "POST",
    description: "WebRTC/STT/TTS for AI agents",
    expectedPrice: "dynamic",
  },
];
