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

type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";
type RateLimitType = "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage";

export interface RateLimitInfo {
  status: RateLimitStatus;
  rateLimitType: RateLimitType;
  utilization: number;
  resetsAt: number;
  isUsingOverage: boolean;
}
