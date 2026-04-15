import { createStore, produce } from "solid-js/store";
import type { TabUsage, UsageSummary, RateLimitInfo } from "../types/usage";

interface UsageState {
  tabs: Record<string, TabUsage>;
  rateLimit: RateLimitInfo | null;
}

const [store, setStore] = createStore<UsageState>({ tabs: {}, rateLimit: null });

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

function updateRateLimit(info: RateLimitInfo) {
  setStore("rateLimit", info);
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
    updateRateLimit,
    get summary() { return getSummary(); },
    get tabs() { return Object.values(store.tabs); },
    get rateLimit() { return store.rateLimit; },
  } as const;
}
