import { Show } from "solid-js";

import type {
  ErrorKind,
  RateLimitDetail,
  SessionStatus,
  UsageReport,
} from "../../types/headless";

import styles from "./headless-panel.module.css";

interface UsageBarProps {
  status: SessionStatus;
  errorKind?: ErrorKind;
  errorMessage?: string;
  usage: UsageReport;
  rateLimit?: RateLimitDetail;
}

function dotClass(status: SessionStatus, errorKind?: ErrorKind): string {
  if (status === "error" || errorKind) return `${styles.statusDot} ${styles.statusDotError}`;
  if (status === "thinking") return `${styles.statusDot} ${styles.statusDotThinking}`;
  if (status === "running") return `${styles.statusDot} ${styles.statusDotRunning}`;
  if (status === "idle") return `${styles.statusDot} ${styles.statusDotIdle}`;
  return styles.statusDot;
}

function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "thinking":
      return "thinking";
    case "running":
      return "tool";
    case "error":
      return "error";
  }
}

/**
 * Top status bar above the message list.
 *
 * Surfaces session lifecycle (idle/thinking/running/error), token usage,
 * and any rate-limit detail. Stays compact so the conversation has the
 * vertical real-estate.
 */
export function UsageBar(props: UsageBarProps) {
  const totalIn = () => props.usage.inputTokens + props.usage.cacheReadTokens;
  return (
    <div class={styles.statusBar}>
      <span class={dotClass(props.status, props.errorKind)} />
      <span>{statusLabel(props.status)}</span>
      <Show when={props.errorMessage}>
        {(msg) => <span class={styles.errorMessage}>{msg()}</span>}
      </Show>
      <div class={styles.usageInfo}>
        <span class={styles.usageItem}>in {totalIn().toLocaleString()}</span>
        <span class={styles.usageItem}>
          out {props.usage.outputTokens.toLocaleString()}
        </span>
        <Show when={props.rateLimit}>
          {(rl) => (
            <span class={styles.usageItem}>
              retry in {Math.ceil(rl().retryAfterMs / 1000)}s
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}
