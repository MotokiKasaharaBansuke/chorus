export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const n = Math.round(count);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatResetsIn(resetsAt: number, now?: number): string {
  if (!Number.isFinite(resetsAt)) return "—";
  const diff = resetsAt - (now ?? Date.now());
  if (diff <= 0) return "now";
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatUtilization(utilization: number): string {
  if (!Number.isFinite(utilization) || utilization < 0) return "0%";
  return `${Math.min(Math.round(utilization * 100), 100)}%`;
}

export const USAGE_WARNING_THRESHOLD = 0.9;
export const USAGE_CAUTION_THRESHOLD = 0.7;

export function utilizationColor(utilization: number): string {
  if (utilization >= USAGE_WARNING_THRESHOLD) return "#d4863a";
  if (utilization >= USAGE_CAUTION_THRESHOLD) return "#d4c43a";
  return "#4abf4a";
}
