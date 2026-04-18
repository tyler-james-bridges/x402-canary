export interface Endpoint {
  name: string;
  url: string;
  method: string;
  description: string;
  expectedPrice?: string;
}

export const endpoints: Endpoint[] = [
  // Bankr x402 Cloud
  {
    name: "Bankr x402 Lint",
    url: "https://x402.bankr.bot/0x72e45a93491a6acfd02da6ceb71a903f3d3b6d08/lint",
    method: "POST",
    description: "x402 compliance linter via Bankr Cloud",
    expectedPrice: "$0.01",
  },
  {
    name: "LITCOIN Chat",
    url: "https://x402.bankr.bot/0xcea8f39419541e6ac9efbdd37b60657b4093ef08/chat",
    method: "POST",
    description: "OpenAI-compatible LLM inference via x402",
    expectedPrice: "$0.001",
  },
  {
    name: "DeFi Yield Compare",
    url: "https://x402.bankr.bot/0xfa04c7d627ba707a1ad17e72e094b45150665593/yield-compare",
    method: "GET",
    description: "Best DeFi yields across 51 protocols ranked by APY",
    expectedPrice: "$0.01",
  },
  {
    name: "Trending Base Coins",
    url: "https://x402.bankr.bot/0xf47535adb19c8905f9384e423063708651ac2805/trending-base-coins",
    method: "GET",
    description: "Trending tokens on Base with price and volume data",
    expectedPrice: "$0.001",
  },
  {
    name: "Regen Oracle",
    url: "https://x402.bankr.bot/0x538aa4800ae2bd8e90556899514376ab96113a8e/regen-oracle",
    method: "POST",
    description: "Live ecological credit data from Regen Ledger",
    expectedPrice: "$0.005",
  },
  // x402scan
  {
    name: "x402scan Resources",
    url: "https://www.x402scan.com/api/x402/resources",
    method: "GET",
    description: "All indexed x402 resources",
    expectedPrice: "$0.01",
  },
  // StableEnrich
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
  // AFK Onchain
  {
    name: "AFK Assembly Intel",
    url: "https://afkonchain.xyz/api/assembly/intel",
    method: "GET",
    description: "AI Assembly Council governance data on Abstract",
    expectedPrice: "$0.01",
  },
  {
    name: "AFK Contract Read",
    url: "https://afkonchain.xyz/api/read?contract=0x0A013Ca2Df9d6C399F9597d438d79Be71B43cb63&function=registrationFee()%20view%20returns%20(uint256)",
    method: "GET",
    description: "Read any smart contract on Abstract L2",
    expectedPrice: "$0.001",
  },
  // StableSocial
  {
    name: "StableSocial TikTok Profile",
    url: "https://stablesocial.dev/api/tiktok/profile",
    method: "POST",
    description: "TikTok user profile data",
    expectedPrice: "$0.06",
  },
  // StableEmail
  {
    name: "StableEmail Send",
    url: "https://stableemail.dev/api/send",
    method: "POST",
    description: "Pay-per-send email delivery",
    expectedPrice: "$0.02",
  },
  // StableUpload
  {
    name: "StableUpload Upload",
    url: "https://stableupload.dev/api/upload",
    method: "POST",
    description: "Pay-per-upload file hosting",
    expectedPrice: "dynamic",
  },
  // StableTravel
  {
    name: "StableTravel Google Flights",
    url: "https://stabletravel.dev/api/google-flights/search",
    method: "GET",
    description: "Google Flights search via x402",
    expectedPrice: "$0.02",
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
