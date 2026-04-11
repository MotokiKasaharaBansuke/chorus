import { createSignal, Show } from "solid-js";
import type { CliConfig, CliMode, CliType } from "../../types";
import styles from "./cli-settings-modal.module.css";

interface CliSettingsModalProps {
  isOpen: boolean;
  defaultWorkingDir: string;
  onSubmit: (config: CliConfig) => void;
  onCancel: () => void;
}

export function CliSettingsModal(props: CliSettingsModalProps) {
  const [cliType, setCliType] = createSignal<CliType>("claude-code");
  const [mode, setMode] = createSignal<CliMode>("default");
  const [workingDir, setWorkingDir] = createSignal(props.defaultWorkingDir);
  const [showDangerConfirm, setShowDangerConfirm] = createSignal(false);

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
              <input
                type="text"
                value={workingDir()}
                onInput={(e) => setWorkingDir(e.currentTarget.value)}
                placeholder={props.defaultWorkingDir || "/path/to/project"}
                class={styles.input}
              />
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
