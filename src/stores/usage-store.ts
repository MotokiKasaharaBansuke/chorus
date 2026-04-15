import { createStore, produce } from "solid-js/store";
import type { TabUsage, UsageSummary, RateLimitEntry } from "../types/usage";

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
    clearRateLimits,
    get summary() { return getSummary(); },
    get tabs() { return Object.values(store.tabs); },
    get rateLimits() { return Object.values(store.rateLimits); },
  } as const;
}
