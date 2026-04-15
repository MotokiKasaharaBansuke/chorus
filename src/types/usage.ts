import type { ReviewCliType } from "./tab";

export interface TabUsage {
  tabId: string;
  tabTitle: string;
  cliType: ReviewCliType;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  turnCount: number;
}

export interface UsageSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTurns: number;
  tabs: readonly TabUsage[];
}
