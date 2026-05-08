import { createEffect, createSignal, on, Show } from "solid-js";
import { open } from "@tauri-apps/plugin-dialog";
import type { CliConfig, CliMode, CliType } from "../../types";
import type { DefaultCliType } from "../../types/settings";
import styles from "./cli-settings-modal.module.css";

interface CliSettingsModalProps {
  isOpen: boolean;
  defaultWorkingDir: string;
  /** User's preferred AI-assistant CLI from settings. Pre-selects the
   *  CLI radio so the modal opens at the user's expected default
   *  rather than the historical hard-coded "claude-code". Typed as
   *  `DefaultCliType` (not `CliType`) so a caller cannot pre-select
   *  `"shell"` or `"file-viewer"` — a user choosing those does it
   *  explicitly each time. */
  defaultCliType?: DefaultCliType;
  onSubmit: (config: CliConfig) => void;
  onCancel: () => void;
}

export function CliSettingsModal(props: CliSettingsModalProps) {
  const [cliType, setCliType] = createSignal<CliType>(
    props.defaultCliType ?? "claude-code",
  );
  const [mode, setMode] = createSignal<CliMode>("default");
  const [workingDir, setWorkingDir] = createSignal(props.defaultWorkingDir);
  const [showDangerConfirm, setShowDangerConfirm] = createSignal(false);

  // Reset the CLI selection to the user's current default every time
  // the modal opens. The modal stays mounted across opens (its
  // visibility is gated by `<Show when={props.isOpen}>` below), so
  // without this effect a setting change made *between* opens would
  // not flow into the radio state.
  createEffect(
    on(
      () => props.isOpen,
      (isOpen) => {
        if (isOpen) setCliType(props.defaultCliType ?? "claude-code");
      },
    ),
  );

  function handleModeChange(newMode: CliMode) {
    if (newMode === "dangerously-skip-permissions") {
      setShowDangerConfirm(true);
    } else {
      setMode(newMode);
    }
  }

  function confirmDangerMode() {
    setMode("dangerously-skip-permissions");
    setShowDangerConfirm(false);
  }

  function handleSubmit(e: Event) {
    e.preventDefault();
    props.onSubmit({
      cliType: cliType(),
      mode: mode(),
      workingDir: workingDir() || props.defaultWorkingDir,
    });
  }

  return (
    <Show when={props.isOpen}>
      <div class={styles.overlay} onClick={props.onCancel}>
        <div class={styles.modal} onClick={(e) => e.stopPropagation()}>
          <h3 class={styles.title}>New Tab</h3>
          <form onSubmit={handleSubmit}>
            <div class={styles.field}>
              <label>CLI</label>
              <div class={styles.buttonGroup}>
                <button
                  type="button"
                  class={cliType() === "claude-code" ? styles.selected : ""}
                  onClick={() => setCliType("claude-code")}
                >Claude Code</button>
                <button
                  type="button"
                  class={cliType() === "codex" ? styles.selected : ""}
                  onClick={() => setCliType("codex")}
                >Codex</button>
                <button
                  type="button"
                  class={cliType() === "shell" ? styles.selected : ""}
                  onClick={() => setCliType("shell")}
                >Shell</button>
              </div>
            </div>

            <Show when={cliType() !== "shell"}>
              <div class={styles.field}>
                <label>Mode</label>
                <div class={styles.buttonGroup}>
                  <button
                    type="button"
                    class={mode() === "default" ? styles.selected : ""}
                    onClick={() => handleModeChange("default")}
                  >Default</button>
                  <button
                    type="button"
                    class={mode() === "plan" ? styles.selected : ""}
                    onClick={() => handleModeChange("plan")}
                  >Plan</button>
                  <button
                    type="button"
                    class={`${mode() === "dangerously-skip-permissions" ? styles.selected : ""} ${styles.dangerBtn}`}
                    onClick={() => handleModeChange("dangerously-skip-permissions")}
                  >Dangerous</button>
                </div>
              </div>
            </Show>

            <div class={styles.field}>
              <label>Working Directory</label>
              <div class={styles.dirRow}>
                <input
                  type="text"
                  value={workingDir()}
                  onInput={(e) => setWorkingDir(e.currentTarget.value)}
                  placeholder={props.defaultWorkingDir || "/path/to/project"}
                  class={styles.input}
                />
                <button
                  type="button"
                  class={styles.browseBtn}
                  title="Choose directory"
                  onClick={async () => {
                    const selected = await open({ directory: true, multiple: false });
                    if (typeof selected === "string") setWorkingDir(selected);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path d="M1 3.5A1.5 1.5 0 012.5 2h3l1.5 2H13.5A1.5 1.5 0 0115 5.5v7A1.5 1.5 0 0113.5 14h-11A1.5 1.5 0 011 12.5V3.5z" fill="currentColor"/>
                  </svg>
                </button>
              </div>
            </div>

            <div class={styles.actions}>
              <button type="button" class={styles.cancelBtn} onClick={props.onCancel}>
                Cancel
              </button>
              <button type="submit" class={styles.submitBtn}>
                Open
              </button>
            </div>
          </form>

          <Show when={showDangerConfirm()}>
            <div class={styles.dangerOverlay}>
              <div class={styles.dangerModal}>
                <h4>Warning</h4>
                <p>
                  This mode allows the CLI to execute file operations and commands
                  without confirmation. Use only in trusted environments.
                </p>
                <div class={styles.dangerActions}>
                  <button class={styles.dangerCancelBtn} onClick={() => setShowDangerConfirm(false)}>Cancel</button>
                  <button class={styles.dangerConfirmBtn} onClick={confirmDangerMode}>
                    I understand, enable
                  </button>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
