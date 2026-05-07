import { Show, createSignal } from "solid-js";

import { killHeadless, spawnHeadless } from "../../lib/headless/commands";
import { useHeadlessStore } from "../../stores/headless-store";

import { HeadlessPanel } from "./headless-panel";
import styles from "./headless-debug-overlay.module.css";

const TAB_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Floating debug overlay for the new headless pipeline.
 *
 * Phase 2 ships this as a *side-by-side* surface so the existing PTY
 * panes keep working untouched. A future phase (3+) will replace this
 * with a full pane integration once the conversation UX is validated.
 *
 * Mounted from `App.tsx` only when `import.meta.env.DEV` is true so it
 * never appears in release builds. The DEV badge in the header makes
 * the in-progress nature visible to anyone running a dev build.
 */
export function HeadlessDebugOverlay() {
  const store = useHeadlessStore();
  const [tabId, setTabId] = createSignal<string | null>(null);
  const [draftTabId, setDraftTabId] = createSignal("debug-1");
  const [cliType, setCliType] = createSignal<"claude-code" | "codex">("claude-code");
  const [cwd, setCwd] = createSignal("");
  const [spawnError, setSpawnError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const spawn = async () => {
    const id = draftTabId().trim();
    if (!TAB_ID_PATTERN.test(id)) {
      setSpawnError("tab id must be 1-64 chars of [A-Za-z0-9-]");
      return;
    }
    const workingDir = cwd().trim();
    if (!workingDir.startsWith("/")) {
      setSpawnError("cwd must be an absolute path (e.g. /Users/you/proj)");
      return;
    }
    setSpawnError(null);
    setBusy(true);
    try {
      await spawnHeadless({ tabId: id, cliType: cliType(), cwd: workingDir });
      setTabId(id);
    } catch (e) {
      console.error("[headless-debug] spawn failed", e);
      setSpawnError(typeof e === "string" ? e : JSON.stringify(e));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    const id = tabId();
    if (!id) return;
    setBusy(true);
    try {
      await killHeadless(id);
    } catch (e) {
      console.error("[headless-debug] kill failed", e);
    } finally {
      store.removeSession(id);
      setTabId(null);
      setBusy(false);
    }
  };

  return (
    <div class={styles.overlay}>
      <div class={styles.header}>
        <span class={styles.devBadge}>DEV</span>
        <span class={styles.title}>Headless agent (Phase 2 preview)</span>
        <Show when={tabId()}>
          {(id) => <span class={styles.tabId}>{id()}</span>}
        </Show>
        <Show when={tabId()}>
          <button class={styles.actionButton} type="button" disabled={busy()} onClick={() => void close()}>
            Close
          </button>
        </Show>
      </div>
      <div class={styles.body}>
        <Show
          when={tabId()}
          fallback={
            <>
              <div class={styles.spawnArea}>
                <div class={styles.spawnRow}>
                  <label class={styles.spawnLabel} for="hd-tab-id">Tab ID</label>
                  <input
                    id="hd-tab-id"
                    class={styles.spawnInput}
                    value={draftTabId()}
                    onInput={(e) => setDraftTabId(e.currentTarget.value)}
                    placeholder="debug-1"
                  />
                </div>
                <div class={styles.spawnRow}>
                  <label class={styles.spawnLabel} for="hd-cli">CLI</label>
                  <select
                    id="hd-cli"
                    class={styles.spawnSelect}
                    value={cliType()}
                    onChange={(e) => setCliType(e.currentTarget.value as "claude-code" | "codex")}
                  >
                    <option value="claude-code">claude-code</option>
                    <option value="codex">codex</option>
                  </select>
                </div>
                <div class={styles.spawnRow}>
                  <label class={styles.spawnLabel} for="hd-cwd">CWD</label>
                  <input
                    id="hd-cwd"
                    class={styles.spawnInput}
                    value={cwd()}
                    onInput={(e) => setCwd(e.currentTarget.value)}
                    placeholder="/absolute/path"
                  />
                </div>
                <div class={styles.spawnRow}>
                  <span class={styles.spawnLabel} />
                  <button
                    class={styles.actionButton}
                    type="button"
                    disabled={busy()}
                    onClick={() => void spawn()}
                  >
                    Spawn
                  </button>
                </div>
              </div>
              <Show when={spawnError()}>
                {(err) => <div class={styles.spawnError}>{err()}</div>}
              </Show>
            </>
          }
        >
          {(id) => <HeadlessPanel tabId={id()} />}
        </Show>
      </div>
    </div>
  );
}
