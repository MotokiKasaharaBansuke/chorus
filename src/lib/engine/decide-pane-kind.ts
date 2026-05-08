import type { CliConfig, PaneKind } from "../../types";
import type { EngineDefault } from "../../types/settings";

/**
 * Decide which engine drives a freshly-spawned pane.
 *
 * `shell` and `file-viewer` are PTY-only by design (no JSONL contract).
 * `claude-code` / `codex` follow the user's `engineDefault` setting; until
 * Phase 4 retires PTY this stays opt-in via Worktree settings → Engine.
 *
 * Pure function so the spawn-time decision can be exercised by unit
 * tests without standing up the SolidJS / Tauri runtime.
 */
export function decidePaneKind(
  config: CliConfig,
  engineDefault: EngineDefault,
): PaneKind {
  if (config.cliType !== "claude-code" && config.cliType !== "codex") {
    return "pty";
  }
  return engineDefault === "headless" ? "headless" : "pty";
}
