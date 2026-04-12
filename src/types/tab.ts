export type TabStatus = "idle" | "running" | "waiting" | "completed" | "error";

export type CliType = "claude-code" | "codex" | "shell" | "file-viewer";

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
}

export interface TabStoreState {
  tabs: Tab[];
  activeTabId: string | null;
}
