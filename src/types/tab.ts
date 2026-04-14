export type TabStatus = "idle" | "running" | "waiting" | "completed" | "error";

export type CliType = "claude-code" | "codex" | "shell" | "file-viewer";

export type ReviewCliType = Extract<CliType, "claude-code" | "codex">;

export type CliMode = "default" | "plan" | "dangerously-skip-permissions";

export interface CliConfig {
  cliType: CliType;
  mode: CliMode;
  model?: string;
  workingDir: string;
}

export interface Tab {
  id: string;
  title: string;
  status: TabStatus;
  cliConfig: CliConfig;
  filePath?: string;
  lastSessionId?: string; // last loaded past session (for restore)
  ptyId?: string; // current PTY ID (differs from tab.id after PTY respawn)
  contentOverride?: string; // inline content for read-only tabs (tool output)
  sourceTabId?: string; // tab that requested this review (for "send back" feature)
}

/** Resolve the effective PTY ID (falls back to tab.id when no respawn has occurred) */
export function effectivePtyId(tab: Tab): string {
  return tab.ptyId ?? tab.id;
}

export interface TabStoreState {
  tabs: Tab[];
  activeTabId: string | null;
}
