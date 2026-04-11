import type { TabStatus } from "../../types";

interface PatternRule {
  pattern: RegExp;
  status: TabStatus;
}

export const CODEX_PATTERNS: readonly PatternRule[] = [
  { pattern: /\$\s*$/, status: "waiting" },
  { pattern: />\s*$/, status: "waiting" },
];
