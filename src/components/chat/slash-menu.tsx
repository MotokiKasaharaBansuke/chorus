import { createMemo, createEffect, For, Show } from "solid-js";
import type { CliType } from "../../types";
import styles from "./chat-panel.module.css";

interface CommandDef {
  id: string;
  label: string;
  desc: string;
  section: string;
  /** Which CLI types support this command. undefined = all. */
  cliTypes?: CliType[];
}

const COMMANDS: CommandDef[] = [
  // --- Context ---
  { id: "attach-file", label: "Attach file…", desc: "Upload a file to include in conversation", section: "Context" },
  { id: "mention-file", label: "Mention file from this project…", desc: "Reference a project file", section: "Context" },
  { id: "clear-conversation", label: "Clear conversation", desc: "Start a new conversation", section: "Context" },
  { id: "resume-conversation", label: "Resume conversation", desc: "Continue a previous conversation", section: "Context", cliTypes: ["claude-code"] },
  // --- Model ---
  { id: "model", label: "Switch model…", desc: "Change the AI model", section: "Model" },
  { id: "switch-account", label: "Switch account…", desc: "Change subscription account for this pane", section: "Model", cliTypes: ["claude-code"] },
  { id: "effort", label: "Effort", desc: "Set effort level", section: "Model", cliTypes: ["claude-code"] },
  { id: "thinking", label: "Thinking", desc: "Toggle extended thinking", section: "Model", cliTypes: ["claude-code"] },
  { id: "account", label: "Account & usage…", desc: "View account info", section: "Model", cliTypes: ["claude-code"] },
  { id: "toggle-fast", label: "Toggle fast mode (Opus 4.6 only)", desc: "Fast/standard", section: "Model", cliTypes: ["claude-code"] },
  // --- Customize ---
  { id: "mcp-config", label: "MCP servers", desc: "Configure MCP servers", section: "Customize", cliTypes: ["claude-code"] },
  { id: "config", label: "General config…", desc: "Open configuration", section: "Customize", cliTypes: ["claude-code"] },
  // --- Slash Commands (Claude Code only) ---
  { id: "compact", label: "/compact", desc: "Compact conversation history", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "init", label: "/init", desc: "Initialize project with CLAUDE.md", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "review", label: "/review", desc: "Review code changes", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "add-feature", label: "/add-feature", desc: "Add a new feature", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "fix-bug", label: "/fix-bug", desc: "Fix a bug", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "refactor", label: "/refactor", desc: "Refactor code", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "debug", label: "/debug", desc: "Debug an issue", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "security-review", label: "/security-review", desc: "Security review", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "simplify", label: "/simplify", desc: "Simplify code", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "cost", label: "/cost", desc: "Show token usage and cost", section: "Slash Commands", cliTypes: ["claude-code"] },
  { id: "context", label: "/context", desc: "Manage context files", section: "Slash Commands", cliTypes: ["claude-code"] },
];

function getFiltered(filter: string, cliType: CliType = "claude-code") {
  const available = COMMANDS.filter(c => !c.cliTypes || c.cliTypes.includes(cliType));
  const q = filter.toLowerCase();
  if (!q) return available;
  return available.filter(c =>
    c.label.toLowerCase().includes(q) ||
    c.desc.toLowerCase().includes(q) ||
    c.id.toLowerCase().includes(q)
  );
}

interface SlashMenuProps {
  filter: string;
  selectedIdx: number;
  onSelect: (command: string) => void;
  cliType?: CliType;
}

function SlashMenu(props: SlashMenuProps) {
  const filtered = createMemo(() => getFiltered(props.filter, props.cliType ?? "claude-code"));

  const grouped = createMemo(() => {
    const groups: Record<string, CommandDef[]> = {};
    for (const cmd of filtered()) {
      if (!groups[cmd.section]) groups[cmd.section] = [];
      groups[cmd.section].push(cmd);
    }
    return Object.entries(groups);
  });

  // Auto-scroll selected into view
  let listRef: HTMLDivElement | undefined;
  createEffect(() => {
    const idx = props.selectedIdx;
    if (listRef) {
      const item = listRef.querySelector(`[data-idx="${idx}"]`);
      item?.scrollIntoView({ block: "nearest" });
    }
  });

  return (
    <Show when={filtered().length > 0}>
      <div class={styles.slashMenu}>
        <div class={styles.slashSearch}>
          <span class={styles.slashSearchLabel}>Filter actions…</span>
        </div>
        <div class={styles.slashList} ref={listRef}>
          <For each={grouped()}>
            {([section, cmds]) => (
              <>
                <div class={styles.slashSection}>{section}</div>
                <For each={cmds}>
                  {(cmd) => {
                    const flatIdx = () => filtered().indexOf(cmd);
                    return (
                      <div
                        class={`${styles.slashItem} ${flatIdx() === props.selectedIdx ? styles.slashItemActive : ""}`}
                        data-idx={flatIdx()}
                        onClick={() => props.onSelect(cmd.id)}
                      >
                        <span class={styles.slashLabel}>{cmd.label}</span>
                        <span class={styles.slashDesc}>{cmd.desc}</span>
                      </div>
                    );
                  }}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}

export { SlashMenu, COMMANDS, getFiltered };
export type { CommandDef };
