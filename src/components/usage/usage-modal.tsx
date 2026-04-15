import { For, Show, onMount, onCleanup } from "solid-js";
import { formatResetsIn, formatUtilization, utilizationColor } from "../../lib/format/usage";
import type { RateLimitEntry } from "../../types/usage";
import styles from "./usage-modal.module.css";

interface UsageModalProps {
  rateLimits: readonly RateLimitEntry[];
  onClose: () => void;
}

export function UsageModal(props: UsageModalProps) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  const sorted = () =>
    [...props.rateLimits].sort((a, b) => b.utilization - a.utilization);

  return (
    <div class={styles.overlay} onClick={props.onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.header}>
          <span class={styles.title}>Usage</span>
          <button class={styles.closeBtn} onClick={props.onClose}>✕</button>
        </div>

        <div class={styles.body}>
          <Show
            when={sorted().length > 0}
            fallback={<div class={styles.empty}>No usage data yet · start a Claude Code session</div>}
          >
            <For each={sorted()}>
              {(entry) => (
                <div class={styles.limitRow}>
                  <div class={styles.limitHeader}>
                    <span class={styles.limitLabel}>{entry.label}</span>
                    <span class={styles.limitPct} style={{ color: utilizationColor(entry.utilization) }}>
                      {formatUtilization(entry.utilization)}
                    </span>
                  </div>
                  <div class={styles.progressTrack}>
                    <div
                      class={styles.progressBar}
                      style={{
                        width: `${Math.min(entry.utilization * 100, 100)}%`,
                        background: utilizationColor(entry.utilization),
                      }}
                    />
                  </div>
                  <div class={styles.limitResets}>
                    Resets in {formatResetsIn(entry.resetsAt)}
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  );
}
