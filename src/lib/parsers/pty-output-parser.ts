import type { CliType, TabStatus } from "../../types";
import { CLAUDE_CODE_PATTERNS } from "./claude-code-patterns";
import { CODEX_PATTERNS } from "./codex-patterns";

// Strip ANSI escape sequences
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

export function detectStatus(output: string, cliType: CliType): TabStatus | null {
  const clean = stripAnsi(output);
  const lastLine = clean.split("\n").filter(Boolean).pop() ?? "";

  const patterns = cliType === "claude-code"
    ? CLAUDE_CODE_PATTERNS
    : cliType === "codex"
      ? CODEX_PATTERNS
      : [];

  for (const rule of patterns) {
    if (rule.pattern.test(lastLine)) {
      return rule.status;
    }
  }

  // If there's new output, it's running
  if (clean.trim().length > 0) {
    return "running";
  }

  return null;
}
