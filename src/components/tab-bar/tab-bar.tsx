import { For } from "solid-js";
import { useTabStore } from "../../stores/tab-store";
import { killPty } from "../../lib/commands";
import { effectivePtyId } from "../../types";
import { removeParser } from "../../lib/stream-parser-registry";
import { TabItem } from "./tab-item";
import styles from "./tab-bar.module.css";

interface TabBarProps {
  onNewTab: () => void;
}

export function TabBar(props: TabBarProps) {
  const store = useTabStore();

  async function handleClose(id: string) {
    const tab = store.getTab(id);
    try {
      await killPty(tab ? effectivePtyId(tab) : id);
    } catch {
      // PTY might already be dead
    }
    store.closeTab(id);
    removeParser(id);
  }

  return (
    <div class={styles.tabBar}>
      <div class={styles.tabList}>
        <For each={store.tabs}>
          {(tab) => (
            <TabItem
              tab={tab}
              isActive={tab.id === store.activeTabId}
              onActivate={() => store.setActiveTab(tab.id)}
              onClose={() => handleClose(tab.id)}
            />
          )}
        </For>
      </div>
      <button
        class={styles.newTabBtn}
        onClick={props.onNewTab}
        disabled={!store.canOpenTab}
        title={store.canOpenTab ? "New Tab (⌘T)" : "Maximum tabs reached (20)"}
      >
        +
      </button>
    </div>
  );
}
