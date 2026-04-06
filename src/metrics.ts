import fs from "fs";
import path from "path";
import { CheckResult } from "./canary.js";

const DATA_FILE = path.join(process.cwd(), "data", "metrics.json");
const MAX_HISTORY = 500;

export interface EndpointMetrics {
  url: string;
  checks: CheckResult[];
  uptimePct: number;
  avgResponseTimeMs: number;
  p95ResponseTimeMs: number;
  lastChecked: string | null;
  lastStatus: number | null;
  isHealthy: boolean;
}

type MetricsStore = Record<string, CheckResult[]>;

function loadStore(): MetricsStore {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      return JSON.parse(raw) as MetricsStore;
    }
  } catch {
    // corrupt file, start fresh
  }
  return {};
}

function saveStore(store: MetricsStore): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

let store: MetricsStore = loadStore();

export function recordCheck(result: CheckResult): void {
  if (!store[result.url]) store[result.url] = [];
  store[result.url].push(result);
  if (store[result.url].length > MAX_HISTORY) {
    store[result.url] = store[result.url].slice(-MAX_HISTORY);
  }
  saveStore(store);
}

export function getMetrics(url: string): EndpointMetrics {
  const checks = store[url] ?? [];
  const healthy = checks.filter((c) => c.isHealthy).length;
  const uptimePct = checks.length > 0 ? (healthy / checks.length) * 100 : 0;

  const times = checks.map((c) => c.responseTimeMs).sort((a, b) => a - b);
  const avgResponseTimeMs =
    times.length > 0 ? times.reduce((s, t) => s + t, 0) / times.length : 0;
  const p95ResponseTimeMs = percentile(times, 95);

  const last = checks[checks.length - 1] ?? null;

  return {
    url,
    checks: checks.slice(-20),
    uptimePct,
    avgResponseTimeMs: Math.round(avgResponseTimeMs),
    p95ResponseTimeMs: Math.round(p95ResponseTimeMs),
    lastChecked: last?.timestamp ?? null,
    lastStatus: last?.status ?? null,
    isHealthy: last?.isHealthy ?? false,
  };
}

export function getAllMetrics(urls: string[]): EndpointMetrics[] {
  return urls.map(getMetrics);
}
