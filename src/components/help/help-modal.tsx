import { For, onMount, onCleanup } from "solid-js";
import styles from "./help-modal.module.css";

interface HelpModalProps {
  onClose: () => void;
}

const SHORTCUTS = [
  { key: "⌘T",       desc: "New pane (opens settings)" },
  { key: "⌘1",       desc: "Quick-launch Claude Code (split)" },
  { key: "⌘2",       desc: "Quick-launch Codex (split)" },
  { key: "⌘W",       desc: "Close active pane" },
  { key: "⌘B",       desc: "Toggle sidebar" },
  { key: "⌘E",       desc: "Equalize pane sizes" },
  { key: "⌘`",       desc: "Toggle bottom terminal" },
  { key: "⌘+  /  ⌘=", desc: "Zoom in" },
  { key: "⌘−",       desc: "Zoom out" },
  { key: "⌘0",       desc: "Reset zoom" },
];

const CLI_COMMANDS = [
  { cmd: "mlm .",                  desc: "Add cwd as a new Claude Code pane in running app" },
  { cmd: "mlm /path/to/project",   desc: "Add specified directory as new pane" },
  { cmd: "mlm --codex .",          desc: "Add new pane with Codex (-x is short form)" },
  { cmd: "mlm --new .",            desc: "Launch a new app instance (-n is short form)" },
  { cmd: "mlm --new --codex .",    desc: "New instance with Codex" },
  { cmd: "mlm --help",             desc: "Show CLI help" },
];

const TAB_DRAG = [
  { action: "Drag tab → center of pane",   desc: "Add as tab in that pane" },
  { action: "Drag tab → edge of pane (30%)", desc: "Split pane left / right / top / bottom" },
  { action: "Drag tab → tab bar",          desc: "Add as tab in that group" },
];

export function HelpModal(props: HelpModalProps) {
  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div class={styles.overlay} onClick={props.onClose}>
      <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div class={styles.header}>
          <span class={styles.title}>Keyboard Shortcuts & Commands</span>
          <button class={styles.closeBtn} onClick={props.onClose}>✕</button>
        </div>

        <div class={styles.body}>
          <section>
            <h3 class={styles.sectionTitle}>Keyboard Shortcuts</h3>
            <table class={styles.table}>
              <For each={SHORTCUTS}>
                {(row) => (
                  <tr>
                    <td class={styles.key}><span class={styles.kbd}>{row.key}</span></td>
                    <td class={styles.desc}>{row.desc}</td>
                  </tr>
                )}
              </For>
            </table>
          </section>

          <section>
            <h3 class={styles.sectionTitle}>Tab Drag & Drop</h3>
            <table class={styles.table}>
              <For each={TAB_DRAG}>
                {(row) => (
                  <tr>
                    <td class={`${styles.key} ${styles.actionCell}`}>{row.action}</td>
                    <td class={styles.desc}>{row.desc}</td>
                  </tr>
                )}
              </For>
            </table>
          </section>

          <section>
            <h3 class={styles.sectionTitle}>
              CLI — <code class={styles.code}>mlm</code>
              <span class={styles.setupHint}>Add <code class={styles.code}>scripts/</code> to PATH to use</span>
            </h3>
            <table class={styles.table}>
              <For each={CLI_COMMANDS}>
                {(row) => (
                  <tr>
                    <td class={styles.key}><code class={styles.code}>{row.cmd}</code></td>
                    <td class={styles.desc}>{row.desc}</td>
                  </tr>
                )}
              </For>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}
