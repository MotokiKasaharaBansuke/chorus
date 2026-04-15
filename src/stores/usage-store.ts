import { createStore, produce } from "solid-js/store";
import type { TabUsage, UsageSummary, RateLimitEntry, RateLimitInfo } from "../types/usage";

const RATE_LIMIT_TYPE_LABELS: Record<string, string> = {
  five_hour: "Session (5hr)",
  seven_day: "Weekly (7 day)",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  overage: "Overage",
};

interface UsageState {
  tabs: Record<string, TabUsage>;
  rateLimits: Record<string, RateLimitEntry>;
}

const [store, setStore] = createStore<UsageState>({ tabs: {}, rateLimits: {} });

function updateTabUsage(usage: TabUsage) {
  setStore(produce((s) => {
    s.tabs[usage.tabId] = usage;
  }));
}

function removeTab(tabId: string) {
  setStore(produce((s) => {
    delete s.tabs[tabId];
  }));
}

function updateRateLimits(entries: RateLimitEntry[]) {
  setStore(produce((s) => {
    for (const entry of entries) {
      s.rateLimits[entry.type] = entry;
    }
  }));
}

function updateRateLimit(info: RateLimitInfo) {
  const entry: RateLimitEntry = {
    type: info.rateLimitType,
    label: RATE_LIMIT_TYPE_LABELS[info.rateLimitType] ?? info.rateLimitType,
    utilization: info.utilization,
    resetsAt: info.resetsAt,
  };
  setStore(produce((s) => { s.rateLimits[entry.type] = entry; }));
}

function clearRateLimits() {
  setStore(produce((s) => { s.rateLimits = {}; }));
}

function getSummary(): UsageSummary {
  const tabs = Object.values(store.tabs);
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTurns = 0;
  for (const t of tabs) {
    totalCostUsd += t.costUsd;
    totalInputTokens += t.inputTokens;
    totalOutputTokens += t.outputTokens;
    totalTurns += t.turnCount;
  }
  totalCostUsd = Math.round(totalCostUsd * 10000) / 10000;
  return { totalCostUsd, totalInputTokens, totalOutputTokens, totalTurns, tabs };
}

export function useUsageStore() {
  return {
    updateTabUsage,
    removeTab,
    updateRateLimits,
    updateRateLimit,
    clearRateLimits,
    get summary() { return getSummary(); },
    get tabs() { return Object.values(store.tabs); },
    get rateLimits() { return Object.values(store.rateLimits); },
  } as const;
}
