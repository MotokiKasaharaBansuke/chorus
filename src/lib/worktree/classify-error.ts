/**
 * Normalizes the `AppError` shape that Tauri produces into a discriminated
 * union frontends can switch on without reading user-facing messages.
 *
 * Rust side uses externally-tagged serde, so tuple variants arrive as
 * `{ WorktreeBranchExists: "feat/foo" }` and struct variants as
 * `{ WorktreeHookFailed: { code, message } }`. Plain unit variants like
 * `GitNotFound` serialize as `"GitNotFound"`.
 */
export type WorktreeErrorKind =
  | "GitRepoNotFound"
  | "GitNotFound"
  | "GitCommandFailed"
  | "WorktreeBranchExists"
  | "WorktreePathExists"
  | "WorktreeCreateFailed"
  | "WorktreeRemoveFailed"
  | "WorktreeHookFailed"
  | "WorktreeInvalidBranchName"
  | "WorktreePathTraversal"
  | "SettingsLoadFailed"
  | "SettingsSaveFailed"
  | "Unknown";

export interface WorktreeErrorInfo {
  kind: WorktreeErrorKind;
  detail: string;
}

export function classifyWorktreeError(err: unknown): WorktreeErrorInfo {
  if (typeof err === "string") {
    return { kind: "Unknown", detail: err };
  }
  if (err instanceof Error) {
    return classifyWorktreeError(err.message);
  }
  if (err && typeof err === "object") {
    if (Object.keys(err).length === 0) {
      return { kind: "Unknown", detail: "(empty error)" };
    }
    const entries = Object.entries(err);
    if (entries.length === 1) {
      const [key, value] = entries[0];
      if (isKnownKind(key)) {
        return { kind: key, detail: stringifyDetail(value) };
      }
      return { kind: "Unknown", detail: `${key}: ${stringifyDetail(value)}` };
    }
  }
  return { kind: "Unknown", detail: String(err) };
}

function isKnownKind(key: string): key is WorktreeErrorKind {
  return [
    "GitRepoNotFound",
    "GitNotFound",
    "GitCommandFailed",
    "WorktreeBranchExists",
    "WorktreePathExists",
    "WorktreeCreateFailed",
    "WorktreeRemoveFailed",
    "WorktreeHookFailed",
    "WorktreeInvalidBranchName",
    "WorktreePathTraversal",
    "SettingsLoadFailed",
    "SettingsSaveFailed",
  ].includes(key);
}

function stringifyDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
