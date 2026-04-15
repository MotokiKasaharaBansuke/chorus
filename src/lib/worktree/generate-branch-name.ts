import { validateBranchName } from "./validate-branch-name";

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatTimestamp(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  // Millisecond component keeps rapid ⌘T presses from colliding on a
  // branch name that would otherwise share the same second.
  return `${date}-${time}-${pad(now.getMilliseconds(), 3)}`;
}

/**
 * Generate a branch name for the auto-create flow. Returns `null` when
 * the combined prefix + auto-suffix does not pass `validateBranchName`
 * (e.g. prefix has disallowed characters), so callers can surface an
 * actionable error to the user instead of silently dropping the worktree.
 */
export function generateAutoBranchName(prefix: string, now: Date): string | null {
  const suffix = `pane-${formatTimestamp(now)}`;
  const trimmed = prefix.trim();

  if (trimmed.length === 0) {
    const result = validateBranchName(suffix);
    return result.ok ? result.normalized : null;
  }

  const separator = trimmed.endsWith("/") ? "" : "/";
  const name = `${trimmed}${separator}${suffix}`;
  const result = validateBranchName(name);
  return result.ok ? result.normalized : null;
}
