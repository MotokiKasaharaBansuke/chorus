/** REPL-only commands that require an interactive PTY instead of stream-json. */

interface ReplCommandDef {
  command: string;
  args: readonly string[];
  title: string;
}

/** Map of slash command IDs to their CLI equivalents. */
const REPL_COMMANDS: Readonly<Record<string, ReplCommandDef>> = {
  login:  { command: "claude", args: ["auth", "login"],  title: "Login" },
  logout: { command: "claude", args: ["auth", "logout"], title: "Logout" },
  doctor: { command: "claude", args: ["doctor"],         title: "Doctor" },
  status: { command: "claude", args: ["auth", "status"], title: "Auth Status" },
};

/** Check if a user-typed message (e.g. "/login") matches a REPL command.
 *  Returns the command ID or `undefined`. */
function matchReplCommand(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const id = trimmed.slice(1).split(/\s/)[0];
  return id && id in REPL_COMMANDS ? id : undefined;
}

export { REPL_COMMANDS, matchReplCommand };
export type { ReplCommandDef };
