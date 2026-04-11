import type { TabStatus } from "../../types";

interface PatternRule {
  pattern: RegExp;
  status: TabStatus;
}

export const CLAUDE_CODE_PATTERNS: readonly PatternRule[] = [
  { pattern: /❯\s*$/, status: "waiting" },
  { pattern: /\$\s*$/, status: "waiting" },
  { pattern: />\s*$/, status: "waiting" },
];
