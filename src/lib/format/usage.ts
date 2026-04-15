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

export function formatResetsIn(resetsAtEpoch: number): string {
  if (!Number.isFinite(resetsAtEpoch) || resetsAtEpoch <= 0) return "soon";
  const diffMs = resetsAtEpoch * 1000 - Date.now();
  if (diffMs < 60_000) return "soon";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
