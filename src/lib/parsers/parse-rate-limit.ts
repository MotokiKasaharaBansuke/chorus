import type { RateLimitEntry } from "../../types/usage";

const LABEL_MAP: Record<string, string> = {
  five_hour: "Session (5hr)",
  seven_day: "Weekly (7 day)",
  weekly_sonnet: "Weekly Sonnet",
  daily: "Daily",
  monthly: "Monthly",
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function extractNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function extractTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) {
    // Values < 1e12 are treated as epoch-seconds (Sep 9 2001 is ~1e9 s; ms timestamps are > 1e12)
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return undefined;
}

function labelFor(type: string): string {
  return LABEL_MAP[type] ?? type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function extractUtilization(obj: Record<string, unknown>): number | undefined {
  const direct = extractNumber(obj.utilization) ?? extractNumber(obj.usage);
  if (direct !== undefined) return direct;
  if (typeof obj.percent_used === "number") return extractNumber(obj.percent_used / 100);
  return undefined;
}

function tryParseEntry(obj: Record<string, unknown>): RateLimitEntry | null {
  // Prefer specific type fields over generic "type" to avoid treating "rate_limit_event" as the limit type
  const type = typeof obj.rate_limit_type === "string" ? obj.rate_limit_type
    : typeof obj.bucket === "string" ? obj.bucket
    : (typeof obj.type === "string" && obj.type !== "rate_limit_event") ? obj.type
    : typeof obj.name === "string" ? obj.name
    : null;
  if (!type) return null;

  const utilization = extractUtilization(obj);
  if (utilization === undefined) return null;

  const resetsAt = extractTimestamp(obj.resets_at)
    ?? extractTimestamp(obj.reset)
    ?? extractTimestamp(obj.resetsAt)
    ?? extractTimestamp(obj.reset_at);
  if (resetsAt === undefined) return null;

  const label = typeof obj.label === "string" ? obj.label : labelFor(type);
  return { type, label, utilization, resetsAt };
}

export function parseRateLimitEvent(data: Record<string, unknown>): RateLimitEntry[] {
  const entries: RateLimitEntry[] = [];

  const nested = toRecord(data.rate_limit);
  if (nested) {
    const entry = tryParseEntry(nested);
    if (entry) entries.push(entry);
  }

  if (Array.isArray(data.rate_limits)) {
    for (const item of data.rate_limits) {
      const rec = toRecord(item);
      if (!rec) continue;
      const entry = tryParseEntry(rec);
      if (entry) entries.push(entry);
    }
  }

  if (Array.isArray(data.claims)) {
    for (const item of data.claims) {
      const rec = toRecord(item);
      if (!rec) continue;
      const entry = tryParseEntry(rec);
      if (entry) entries.push(entry);
    }
  }

  if (entries.length === 0) {
    const entry = tryParseEntry(data);
    if (entry) entries.push(entry);
  }

  if (entries.length === 0) {
    console.warn("[Chorus] Unknown rate_limit_event format:", JSON.stringify(data).slice(0, 500));
  }

  return entries;
}
