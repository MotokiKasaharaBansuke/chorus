import { onCleanup, onMount } from "solid-js";
import { useTerminal } from "./use-terminal";
import type { Tab } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import styles from "./terminal-panel.module.css";

interface TerminalPanelProps {
  tab: Tab;
  isActive: boolean;
}

export function TerminalPanel(props: TerminalPanelProps) {
  let containerRef: HTMLDivElement | undefined;
  const store = useTabStore();

  const terminal = useTerminal({
    ptyId: props.tab.id,
    cliType: props.tab.cliConfig.cliType,
    onStatusChange: (status) => {
      store.updateStatus(props.tab.id, status);
    },
  });

  onMount(() => {
    if (containerRef) {
      terminal.mount(containerRef);
    }
  });

  onCleanup(() => {
    terminal.dispose();
  });

  return (
    <div class={styles.container}>
      <div ref={containerRef} class={styles.terminal} />
    </div>
  );
}
