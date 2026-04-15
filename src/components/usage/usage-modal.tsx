import { For, Show, onMount, onCleanup } from "solid-js";
import { formatCost, formatTokens } from "../../lib/format/usage";
import type { UsageSummary } from "../../types";
import styles from "./usage-modal.module.css";

interface UsageModalProps {
  summary: UsageSummary;
  onClose: () => void;
}

export function UsageModal(props: UsageModalProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  const sorted = () =>
    [...props.summary.tabs].sort((a, b) => b.costUsd - a.costUsd);

  return (
    <div class={styles.overlay} onClick={props.onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.header}>
          <span class={styles.title}>Session Usage</span>
          <button class={styles.closeBtn} onClick={props.onClose}>✕</button>
        </div>

        <div class={styles.body}>
          <section>
            <h3 class={styles.sectionTitle}>Summary</h3>
            <div class={styles.summaryGrid}>
              <div class={styles.summaryCard}>
                <div class={styles.summaryLabel}>Total Cost</div>
                <div class={styles.summaryValue}>{formatCost(props.summary.totalCostUsd)}</div>
              </div>
              <div class={styles.summaryCard}>
                <div class={styles.summaryLabel}>Turns</div>
                <div class={styles.summaryValue}>{props.summary.totalTurns}</div>
              </div>
              <div class={styles.summaryCard}>
                <div class={styles.summaryLabel}>Input Tokens</div>
                <div class={styles.summaryValue}>{formatTokens(props.summary.totalInputTokens)}</div>
              </div>
              <div class={styles.summaryCard}>
                <div class={styles.summaryLabel}>Output Tokens</div>
                <div class={styles.summaryValue}>{formatTokens(props.summary.totalOutputTokens)}</div>
              </div>
            </div>
          </section>

          <section>
            <h3 class={styles.sectionTitle}>Per Pane</h3>
            <Show when={sorted().length > 0} fallback={<div class={styles.empty}>No active panes</div>}>
              <table class={styles.tabTable}>
                <thead>
                  <tr>
                    <th>Pane</th>
                    <th>Cost</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Turns</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={sorted()}>
                    {(tab) => (
                      <tr>
                        <td>
                          <div class={styles.tabName}>
                            <span class={`${styles.cliBadge} ${tab.cliType === "claude-code" ? styles.cliBadgeClaude : styles.cliBadgeCodex}`}>
                              {tab.cliType === "claude-code" ? "Claude" : "Codex"}
                            </span>
                            {tab.tabTitle}
                          </div>
                        </td>
                        <td>{formatCost(tab.costUsd)}</td>
                        <td>{formatTokens(tab.inputTokens)}</td>
                        <td>{formatTokens(tab.outputTokens)}</td>
                        <td>{tab.turnCount}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </section>
        </div>
      </div>
    </div>
  );
}
