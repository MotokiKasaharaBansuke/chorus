import { createSignal, For, Show } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { HelpModal } from "../help/help-modal";
import { SidebarIcon, TerminalIcon, RefreshIcon } from "../icons";
import { formatResetsIn, formatUtilization, USAGE_WARNING_THRESHOLD } from "../../lib/format/usage";
import type { ZombieSessionInfo } from "../../lib/commands";
import type { CliMode, ReviewCliType } from "../../types";
import type { DefaultCliType, EngineDefault } from "../../types/settings";
import type { RateLimitEntry } from "../../types/usage";
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
  /** Default execution engine for new Claude/Codex panes. */
  engineDefault: EngineDefault;
  onEngineDefaultChange: (engine: EngineDefault) => void;
  /** CLI pre-selected when the user opens the new-pane modal. */
  defaultCliType: DefaultCliType;
  onDefaultCliTypeChange: (cli: DefaultCliType) => void;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  onOpenWorktreeSettings: () => void;
  zombieSessions: ZombieSessionInfo[];
  onKillZombie: (id: string) => void;
  onKillAllZombies: () => void;
  hasActiveTab: boolean;
  isActiveTabStale: boolean;
  onRefreshActiveTab: () => void;
  rateLimits: readonly RateLimitEntry[];
  onViewUsage: () => void;
}

function highestUtilizationEntry(rateLimits: readonly RateLimitEntry[]): RateLimitEntry | null {
  if (rateLimits.length === 0) return null;
  return [...rateLimits].sort((a, b) => b.utilization - a.utilization)[0] ?? null;
}

export function TopBar(props: TopBarProps) {
  const tabStore = useTabStore();
  const [showSettings, setShowSettings] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  const [showZombies, setShowZombies] = createSignal(false);

  const highestUtilization = () => highestUtilizationEntry(props.rateLimits);

  return (
    <div class={styles.topBar}>
      <div class={styles.right}>
        <Show when={highestUtilization()}>
          {(entry) => (
            <button
              class={`${styles.usageBanner} ${entry().utilization >= USAGE_WARNING_THRESHOLD ? styles.usageBannerWarn : ""}`}
              onClick={props.onViewUsage}
              title="View subscription usage"
            >
              <span class={styles.usagePct}>{formatUtilization(entry().utilization)}</span>
              <span class={styles.usageSep}>·</span>
              <span class={styles.usageResets}>resets in {formatResetsIn(entry().resetsAt)}</span>
              <span class={styles.usageLink}>View usage</span>
            </button>
          )}
        </Show>
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
                Bypass
                <span class={`${styles.itemTag} ${styles.itemTagDanger}`}>DANGER</span>
              </div>
              <div class={styles.divider} />
              {/* Pre-selection for the New Pane (⌘T) modal. Shell is
                  reachable from the modal but never the default. */}
              <div class={styles.dropdownTitle}>Default CLI for new panes</div>
              <div class={`${styles.dropdownItem} ${props.defaultCliType === "claude-code" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onDefaultCliTypeChange("claude-code"); setShowSettings(false); }}>
                Claude Code
              </div>
              <div class={`${styles.dropdownItem} ${props.defaultCliType === "codex" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onDefaultCliTypeChange("codex"); setShowSettings(false); }}>
                Codex
              </div>
              <div class={styles.divider} />
              <div class={styles.dropdownTitle}>Review CLI</div>
              <div class={`${styles.dropdownItem} ${props.reviewCliType === "codex" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onReviewCliTypeChange("codex"); setShowSettings(false); }}>Codex</div>
              <div class={`${styles.dropdownItem} ${props.reviewCliType === "claude-code" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onReviewCliTypeChange("claude-code"); setShowSettings(false); }}>Claude Code</div>
              <div class={styles.divider} />
              {/* Engine: which execution backend new Claude/Codex panes use.
                  Headless is opt-in until Phase 4 retires PTY entirely. */}
              <div class={styles.dropdownTitle}>Engine</div>
              <div class={`${styles.dropdownItem} ${props.engineDefault === "pty" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onEngineDefaultChange("pty"); setShowSettings(false); }}>
                PTY
                <span class={`${styles.itemTag} ${styles.itemTagMuted}`}>default</span>
              </div>
              <div class={`${styles.dropdownItem} ${props.engineDefault === "headless" ? styles.dropdownActive : ""}`}
                onClick={() => { props.onEngineDefaultChange("headless"); setShowSettings(false); }}>
                Headless
                <span class={`${styles.itemTag} ${styles.itemTagWarn}`}>experimental</span>
              </div>
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
        <Show when={props.zombieSessions.length > 0}>
          <div class={styles.dropdownWrap}>
            <button
              class={`${styles.btn} ${styles.zombieBtn}`}
              onClick={() => setShowZombies(!showZombies())}
              title={`${props.zombieSessions.length} zombie session(s) — click to manage`}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M1 1l14 14M1 15L15 1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
              <span class={styles.zombieBadge}>{props.zombieSessions.length}</span>
            </button>
            <Show when={showZombies()}>
              <div class={`${styles.dropdown} ${styles.zombieDropdown}`}>
                <div class={styles.dropdownTitle}>Zombie Sessions</div>
                <For each={props.zombieSessions}>
                  {(session) => (
                    <div class={styles.zombieRow}>
                      <span class={styles.zombieCliType}>{session.cliType}</span>
                      <span class={styles.zombieId}>{session.id.slice(0, 8)}</span>
                      <button
                        class={styles.zombieKillBtn}
                        onClick={() => { props.onKillZombie(session.id); }}
                        title={`Kill session ${session.id}`}
                      >
                        Kill
                      </button>
                    </div>
                  )}
                </For>
                <div class={styles.divider} />
                <div
                  class={`${styles.dropdownItem} ${styles.zombieKillAll}`}
                  onClick={() => { props.onKillAllZombies(); setShowZombies(false); }}
                >
                  Kill All
                </div>
              </div>
            </Show>
          </div>
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
