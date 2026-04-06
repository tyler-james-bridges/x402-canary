# x402-canary

Canary monitor for the x402 agent economy. Polls a set of x402-enabled API endpoints every 30 seconds and serves a brutalist black/white dashboard at [canary.0x402.sh](https://canary.0x402.sh).

## What it does

- Checks each endpoint for HTTP status, response time, and x402 payment details
- Parses the `payment-required` header (base64 JSON) to surface price, network, token, and scheme
- Displays live status: UP, DOWN, or X402 (payment required but healthy)
- Auto-refreshes every 30 seconds

## Stack

- Vercel serverless function (`api/health.ts`) -- no persistence, each request is a fresh check
- Static frontend (`public/index.html`) -- vanilla JS, no framework
- TypeScript, Geist Mono, brutalist black/white design

## Monitored endpoints

Defined in `api/health.ts`. Current list:

| Name | URL |
|---|---|
| x402scan Merchants | https://www.x402scan.com/api/x402/merchants |
| x402scan Resources | https://www.x402scan.com/api/x402/resources |
| StableEnrich Exa Search | https://stableenrich.dev/api/exa/search |
| StableEnrich Apollo People | https://stableenrich.dev/api/apollo/people-search |
| AgentCash | https://agentcash.dev/api/send |
| Base RPC | https://mainnet.base.org |

## Adding an endpoint

Edit `api/health.ts` and add an entry to the `ENDPOINTS` array:

```ts
{ name: "My Service", url: "https://example.com/api/endpoint", method: "GET" }
```

Supported methods: `GET`, `POST`. POST requests send an empty JSON body.

## API

`GET /api/health` returns:

```json
{
  "timestamp": "2025-01-01T00:00:00.000Z",
  "summary": { "total": 6, "online": 5, "degraded": 1, "x402Enabled": 3 },
  "endpoints": [
    {
      "name": "...",
      "url": "...",
      "status": 402,
      "responseTimeMs": 120,
      "isHealthy": true,
      "isX402": true,
      "x402Details": { "accepts": [{ "maxAmountRequired": "1000", "network": "base-mainnet", ... }] }
    }
  ]
}
```

## Local development

```bash
npm install
vercel dev   # runs on http://localhost:3000
```

## Deployment

Vercel auto-deploys on push to `main`. Production: [canary.0x402.sh](https://canary.0x402.sh)
