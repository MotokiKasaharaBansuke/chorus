import { createSignal, Show } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { HelpModal } from "../help/help-modal";
import { SidebarIcon, TerminalIcon, RefreshIcon } from "../icons";
import { formatCost, formatTokens, formatResetsIn } from "../../lib/format/usage";
import type { CliMode, ReviewCliType } from "../../types";
import type { UsageSummary, RateLimitInfo } from "../../types";
import styles from "./top-bar.module.css";

interface TopBarProps {
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  onNewTab: () => void;
  canOpenTab: boolean;
  quickLaunchMode: CliMode;
  onQuickLaunchModeChange: (mode: CliMode) => void;
  reviewCliType: ReviewCliType;
  onReviewCliTypeChange: (type: ReviewCliType) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  onOpenWorktreeSettings: () => void;
  zombieCount: number;
  onKillZombies: () => void;
  hasActiveTab: boolean;
  isActiveTabStale: boolean;
  onRefreshActiveTab: () => void;
  usageSummary: UsageSummary;
  rateLimit: RateLimitInfo | null;
  onViewUsage: () => void;
}

const RATE_LIMIT_LABELS: Record<RateLimitInfo["rateLimitType"], string> = {
  five_hour: "session limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
  overage: "extra usage",
};

function rateLimitText(info: RateLimitInfo): string {
  const pct = Math.round(info.utilization * 100);
  const label = RATE_LIMIT_LABELS[info.rateLimitType];
  const resets = formatResetsIn(info.resetsAt);
  if (info.status === "rejected") {
    return `You've hit your ${label} · resets in ${resets}`;
  }
  return `You've used ${pct}% of your ${label} · resets in ${resets}`;
}

export function TopBar(props: TopBarProps) {
  const tabStore = useTabStore();
  const [showSettings, setShowSettings] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);

  return (
    <div class={styles.topBar}>
      <div class={styles.right}>
        <button class={styles.btn} onClick={props.onToggleSidebar} title="Toggle Sidebar (⌘B)">
          <SidebarIcon isOpen={props.isSidebarOpen} size={14} />
        </button>
        <button class={styles.btn} onClick={props.onToggleTerminal} title="Toggle Terminal (⌘`)">
          <TerminalIcon size={14} />
        </button>
        <Show when={tabStore.layout && tabStore.layout.type === "split"}>
          <button class={styles.btn} onClick={() => tabStore.equalize()} title="Equalize pane sizes (⌘E)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <rect x="9" y="2" width="6" height="12" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
            </svg>
          </button>
        </Show>
        <Show when={props.hasActiveTab}>
          <button
            class={`${styles.btn} ${props.isActiveTabStale ? styles.staleBtn : ""}`}
            onClick={props.onRefreshActiveTab}
            title={props.isActiveTabStale ? "Session out of sync — click to refresh" : "Refresh session (⇧⌘R)"}
          >
            <RefreshIcon size={14} />
          </button>
        </Show>
        <div class={styles.dropdownWrap}>
          <button class={styles.btn} onClick={() => setShowSettings(!showSettings())} title="Settings (⌘1/⌘2)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1a1 1 0 011 1v1.07a5 5 0 011.82.76l.75-.76a1 1 0 011.42 1.42l-.76.75A5 5 0 0113.93 7H15a1 1 0 010 2h-1.07a5 5 0 01-.76 1.82l.76.75a1 1 0 01-1.42 1.42l-.75-.76A5 5 0 019 12.93V14a1 1 0 01-2 0v-1.07a5 5 0 01-1.82-.76l-.75.76a1 1 0 01-1.42-1.42l.76-.75A5 5 0 012.07 9H1a1 1 0 010-2h1.07a5 5 0 01.76-1.82l-.76-.75a1 1 0 011.42-1.42l.75.76A5 5 0 017 3.07V2a1 1 0 011-1zm0 4.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" fill="currentColor"/>
            </svg>
          </button>
          <Show when={showSettings()}>
            <div class={styles.dropdown}>
              <div class={styles.dropdownTitle}>Quick Launch Mode (⌘1/⌘2)</div>
              <div class={`${styles.dropdownItem} ${props.quickLaunchMode === "default" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onQuickLaunchModeChange("default"); setShowSettings(false); }}>Default</div>
              <div class={`${styles.dropdownItem} ${props.quickLaunchMode === "plan" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onQuickLaunchModeChange("plan"); setShowSettings(false); }}>Plan</div>
              <div class={`${styles.dropdownItem} ${props.quickLaunchMode === "dangerously-skip-permissions" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onQuickLaunchModeChange("dangerously-skip-permissions"); setShowSettings(false); }}>
                Bypass permissions
                <span style={{ color: "#c74e39", "font-size": "10px", "margin-left": "4px" }}>DANGER</span>
              </div>
              <div class={styles.divider} />
              <div class={styles.dropdownTitle}>Review CLI</div>
              <div class={`${styles.dropdownItem} ${props.reviewCliType === "codex" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onReviewCliTypeChange("codex"); setShowSettings(false); }}>Codex</div>
              <div class={`${styles.dropdownItem} ${props.reviewCliType === "claude-code" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onReviewCliTypeChange("claude-code"); setShowSettings(false); }}>Claude Code</div>
              <div class={styles.divider} />
              <div
                class={styles.dropdownItem}
                onClick={() => { setShowSettings(false); props.onOpenWorktreeSettings(); }}
              >
                Worktree settings…
              </div>
              <div class={styles.divider} />
              <div class={styles.dropdownTitle}>Font Size</div>
              <div class={styles.fontRow}>
                <button class={styles.fontBtn} onClick={() => props.onFontSizeChange(props.fontSize - 1)}>−</button>
                <span class={styles.fontValue}>{props.fontSize}px</span>
                <button class={styles.fontBtn} onClick={() => props.onFontSizeChange(props.fontSize + 1)}>+</button>
              </div>
            </div>
          </Show>
        </div>
        <button class={styles.btn} onClick={props.onNewTab} disabled={!props.canOpenTab} title="New Pane (⌘T)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        <Show when={props.zombieCount > 0}>
          <button
            class={`${styles.btn} ${styles.zombieBtn}`}
            onClick={props.onKillZombies}
            title={`Kill ${props.zombieCount} zombie session(s)`}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M1 1l14 14M1 15L15 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            <span class={styles.zombieBadge}>{props.zombieCount}</span>
          </button>
        </Show>
        <Show when={props.rateLimit && props.rateLimit.status !== "allowed" ? props.rateLimit : undefined}>
          {(info) => (
            <div class={`${styles.rateLimitBanner} ${info().status === "rejected" ? styles.rateLimitRejected : ""}`}>
              <span class={styles.rateLimitText}>{rateLimitText(info())}</span>
            </div>
          )}
        </Show>
        <Show when={props.usageSummary.totalCostUsd > 0}>
          <button class={styles.usageBanner} onClick={props.onViewUsage} title="View session usage">
            <span class={styles.usageCost}>{formatCost(props.usageSummary.totalCostUsd)}</span>
            <span class={styles.usageSep}>·</span>
            <span class={styles.usageTokens}>{formatTokens(props.usageSummary.totalInputTokens + props.usageSummary.totalOutputTokens)} tokens</span>
            <span class={styles.usageLink}>View usage</span>
          </button>
        </Show>
        <button class={styles.btn} onClick={() => setShowHelp(true)} title="Keyboard shortcuts & CLI commands">
          ?
        </button>
      </div>

      <Show when={showHelp()}>
        <HelpModal onClose={() => setShowHelp(false)} />
      </Show>
    </div>
  );
}
