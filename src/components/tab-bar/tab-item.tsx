import type { Tab } from "../../types";
import { StatusIndicator } from "../status/status-indicator";
import styles from "./tab-bar.module.css";

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}

export function TabItem(props: TabItemProps) {
  const isDangerous = () => props.tab.cliConfig.mode === "dangerously-skip-permissions";

  return (
    <div
      class={`${styles.tab} ${props.isActive ? styles.active : ""} ${isDangerous() ? styles.dangerous : ""}`}
      onClick={props.onActivate}
    >
      <StatusIndicator status={props.tab.status} />
      <span class={styles.tabTitle}>{props.tab.title}</span>
      {isDangerous() && <span class={styles.dangerBadge}>DANGER</span>}
      <button
        class={styles.closeBtn}
        onClick={(e) => {
          e.stopPropagation();
          props.onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
