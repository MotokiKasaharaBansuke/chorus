import type { TabStatus } from "../../types";
import styles from "./status-indicator.module.css";

interface StatusIndicatorProps {
  status: TabStatus;
}

const STATUS_MAP: Record<TabStatus, { symbol: string; className: string }> = {
  idle: { symbol: "○", className: "idle" },
  running: { symbol: "●", className: "running" },
  waiting: { symbol: "●", className: "waiting" },
  completed: { symbol: "✓", className: "completed" },
  error: { symbol: "✗", className: "error" },
};

export function StatusIndicator(props: StatusIndicatorProps) {
  const info = () => STATUS_MAP[props.status];

  return (
    <span class={`${styles.indicator} ${styles[info().className]}`}>
      {info().symbol}
    </span>
  );
}
