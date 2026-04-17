import { onMount, onCleanup } from "solid-js";
import { killPty } from "../../lib/commands";
import { ptyExitDispatcher } from "../../lib/event-dispatcher";
import { useTerminal } from "./use-terminal";
import styles from "./terminal-modal.module.css";

interface TerminalModalProps {
  title: string;
  ptyId: string;
  onClose: () => void;
}

export function TerminalModal(props: TerminalModalProps) {
  let termRef: HTMLDivElement | undefined;
  // Non-reactive flag — only read in onCleanup to skip killPty on already-exited processes
  let hasExited = false;

  const term = useTerminal({
    ptyId: props.ptyId,
    cliType: "shell",
    onStatusChange: () => {},
  });

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
    if (termRef) term.mount(termRef);

    const unsubExit = ptyExitDispatcher.subscribe(props.ptyId, () => {
      hasExited = true;
    });

    onCleanup(() => unsubExit());
  });

  // Outer onCleanup fires after the inner one (exit unsub), so hasExited is final here
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
    term.dispose();
    if (!hasExited) {
      killPty(props.ptyId).catch(() => {});
    }
  });

  return (
    <div class={styles.overlay} onClick={props.onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.header}>
          <span class={styles.title}>{props.title}</span>
          <button class={styles.closeBtn} onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div class={styles.terminalContainer} ref={termRef} />
      </div>
    </div>
  );
}
