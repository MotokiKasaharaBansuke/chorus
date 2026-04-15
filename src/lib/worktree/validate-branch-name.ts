export const MAX_BRANCH_NAME_LEN = 100;

export type BranchNameValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: string };

/**
 * Frontend mirror of the Rust allowlist. Keep in sync with
 * `src-tauri/src/worktree/mod.rs::branch_name::validate`.
 * Intentionally ASCII-only so paths are stable across NFC/NFD/HFS+ quirks.
 */
export function validateBranchName(raw: string): BranchNameValidation {
  const normalized = raw.normalize("NFC");

  if (normalized.length === 0) return fail("empty");
  if (normalized.length > MAX_BRANCH_NAME_LEN) return fail(`longer than ${MAX_BRANCH_NAME_LEN}`);

  const first = normalized.charCodeAt(0);
  const isAsciiAlnum = (c: number) =>
    (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  if (!isAsciiAlnum(first)) return fail("must start with ASCII alphanumeric");

  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if (code === 0 || code < 0x20 || code === 0x7f) return fail("contains control characters");
    const allowed = isAsciiAlnum(code) || ch === "/" || ch === "_" || ch === "." || ch === "-";
    if (!allowed) return fail(`disallowed character: ${JSON.stringify(ch)}`);
  }

  for (const seg of normalized.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return fail(`invalid segment: ${JSON.stringify(seg)}`);
    if (seg.endsWith(".lock")) return fail("segment ends with .lock");
  }

  return { ok: true, normalized };
}

function fail(reason: string): BranchNameValidation {
  return { ok: false, reason };
}
