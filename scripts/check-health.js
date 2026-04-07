#!/usr/bin/env node
// check-health.js — standalone health checker, no deps, runs in GitHub Actions

import { writeFileSync, mkdirSync } from 'fs';

const ENDPOINTS = [
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
  {
    name: "AgentCash Send",
    url: "https://agentcash.dev/api/send",
    method: "POST",
    description: "Send USDC on Base/Solana",
    expectedPrice: "dynamic",
  },
  {
    name: "Base RPC",
    url: "https://mainnet.base.org",
    method: "POST",
    description: "Base L2 mainnet RPC",
    expectedPrice: "free",
  },
];

function parseX402Header(wwwAuth) {
  if (!wwwAuth) return null;
  try {
    // Format: "x402 <base64json>"
    const parts = wwwAuth.split(' ');
    if (parts.length < 2) return null;
    const decoded = Buffer.from(parts[1], 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    // Normalize from accepts array
    const accepts = parsed.accepts || [];
    if (accepts.length === 0) return null;
    const first = accepts[0];
    const price = first.maxAmountRequired
      ? '$' + (parseInt(first.maxAmountRequired, 10) / 1_000_000).toFixed(2)
      : null;
    const network = first.network || null;
    const token = first.asset
      ? (first.asset.symbol || 'USDC')
      : 'USDC';
    return { price, network, token, version: 'x402' };
  } catch {
    return null;
  }
}

async function checkEndpoint(ep) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(ep.url, {
      method: ep.method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: ep.method === 'POST' ? '{}' : undefined,
    });
    clearTimeout(timer);
    const responseTimeMs = Date.now() - start;
    const isHealthy = res.status < 500;
    const isX402 = res.status === 402;
    const wwwAuth = res.headers.get('www-authenticate') || res.headers.get('WWW-Authenticate');
    const x402Details = isX402 ? parseX402Header(wwwAuth) : null;
    return {
      name: ep.name,
      url: ep.url,
      description: ep.description,
      expectedPrice: ep.expectedPrice,
      isHealthy,
      isX402,
      x402Details,
      status: String(res.status),
      lastStatus: res.status,
      responseTimeMs,
      lastChecked: new Date().toISOString(),
    };
  } catch (err) {
    return {
      name: ep.name,
      url: ep.url,
      description: ep.description,
      expectedPrice: ep.expectedPrice,
      isHealthy: false,
      isX402: false,
      x402Details: null,
      status: 'ERR',
      lastStatus: null,
      responseTimeMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
      error: err.message,
    };
  }
}

const results = await Promise.all(ENDPOINTS.map(checkEndpoint));

const total = results.length;
const online = results.filter(r => r.isHealthy).length;
const degraded = results.filter(r => !r.isHealthy).length;
const x402Enabled = results.filter(r => r.isX402).length;

const output = {
  timestamp: new Date().toISOString(),
  summary: { total, online, degraded, x402Enabled },
  endpoints: results,
};

mkdirSync('data', { recursive: true });
writeFileSync('data/health.json', JSON.stringify(output, null, 2));

console.log(`Checked ${total} endpoints: ${online} online, ${degraded} degraded, ${x402Enabled} x402`);
results.forEach(r => {
  const icon = r.isHealthy ? 'OK' : 'FAIL';
  console.log(`  [${icon}] ${r.name} — ${r.status} (${r.responseTimeMs}ms)`);
});
