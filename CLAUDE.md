# x402-canary

Canary network monitor for the x402 agent economy. Checks endpoint health every 60s, persists metrics to disk, serves a brutalist dashboard on port 3402.

## Stack

- TypeScript, Node.js (NodeNext modules)
- tsx for dev execution
- No frameworks — stdlib http server only
- Geist Mono, black/white brutalist UI

## Design System

- Background: #000, foreground: #fff
- Borders: 2px solid, zero border-radius
- All text uppercase where used as labels
- Degraded endpoints get red (#f00) border + badge
- Font: Geist Mono

## Running

```bash
npm run dev        # run with tsx (hot-ish)
npm start          # same
```

Dashboard: http://localhost:3402
Health API: http://localhost:3402/api/health

## File Layout

```
src/
  endpoints.ts   — list of monitored endpoints
  canary.ts      — checkEndpoint() fetch + timing
  metrics.ts     — in-memory + JSON persistence (data/metrics.json)
  dashboard.ts   — HTTP server, GET / and GET /api/health
  index.ts       — entry point, starts checks + dashboard
public/
  index.html     — dashboard UI, auto-refreshes every 30s
data/
  metrics.json   — auto-created, persists check history
```

## Adding Endpoints

Edit `src/endpoints.ts`. Add an object with `name`, `url`, `description`. The monitor picks it up on next restart.

## Notes

- Checks run every 60s via setInterval
- Up to 500 check results kept per endpoint
- isHealthy = HTTP status < 500 (redirects count as healthy)
- Timeout per check: 10s
- No x402 payment integration yet
