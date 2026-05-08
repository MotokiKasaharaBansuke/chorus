/**
 * Type-safe wrappers around the Tauri commands defined in
 * `src-tauri/src/commands/headless_commands.rs`.
 *
 * Each function mirrors a `#[tauri::command]` so the frontend never has
 * to remember the snake_case command name or the camelCase payload shape.
 * Errors propagate as `unknown` (Tauri serializes Rust `AppError` as a
 * tagged object); use `classifyHeadlessError` to map back to a UI verdict.
 */

import { invoke } from "@tauri-apps/api/core";

import type {
  InspectHeadlessLockResponse,
  RequestId,
  SpawnHeadlessRequest,
  TabId,
} from "../../types/headless";

/**
 * Start a headless session and register it server-side. The returned
 * value is the freshly-allocated `tabId` (echoed back from the request
 * for symmetry with the PTY pipeline's `spawn_pty`).
 */
export async function spawnHeadless(request: SpawnHeadlessRequest): Promise<TabId> {
  return invoke<TabId>("spawn_headless", { request });
}

/**
 * Wire shape for an image attachment passed to `writeHeadlessInput`.
 * `path` must already live under `/tmp/chorus-images/` (enforced by
 * the backend `image::load_attachment` allowlist) — frontend callers
 * use the `saveTempImage` IPC to land bytes there before sending.
 */
export interface HeadlessImageAttachment {
  path: string;
  mediaType: string;
}

/**
 * Send a user message to the running session. Returns the Chorus-side
 * `requestId` so callers can correlate the assistant reply they later
 * receive on the per-tab event channel.
 *
 * Optional `images` attach to the same turn — the backend reads each
 * file, base64-encodes it, and embeds an `image` content block in the
 * stream-json envelope claude expects.
 */
export async function writeHeadlessInput(
  tabId: TabId,
  text: string,
  images: HeadlessImageAttachment[] = [],
): Promise<RequestId> {
  return invoke<RequestId>("write_headless_input", {
    request: { tabId, text, images },
  });
}

/**
 * Send the protocol-level cancel envelope. Does not kill the process —
 * use `killHeadless` for that.
 */
export async function cancelHeadlessMessage(tabId: TabId): Promise<void> {
  return invoke<void>("cancel_headless_message", {
    request: { tabId },
  });
}

/** Tear the session down: graceful close → SIGTERM → SIGKILL. */
export async function killHeadless(tabId: TabId): Promise<void> {
  return invoke<void>("kill_headless", { request: { tabId } });
}

/**
 * Inspect the lock file for `tabId` without acquiring it.
 * `ageSeconds` is `null` when no lock file exists.
 */
export async function inspectHeadlessLock(
  tabId: TabId,
): Promise<InspectHeadlessLockResponse> {
  return invoke<InspectHeadlessLockResponse>("inspect_headless_lock", {
    request: { tabId },
  });
}

/**
 * Forcibly remove the lock file. Caller must have first inspected the
 * lock with `inspectHeadlessLock` and obtained explicit user consent —
 * this command performs no staleness check of its own.
 */
export async function forceReleaseHeadlessLock(tabId: TabId): Promise<void> {
  return invoke<void>("force_release_headless_lock", {
    request: { tabId },
  });
}

/** Coarse classification for surfacing Tauri errors to users. */
export type HeadlessErrorKind = "session_busy" | "not_found" | "spawn_failed" | "other";

/**
 * Map an unknown error from a `headless_*` invoke onto a UI verdict.
 *
 * Tauri serializes `AppError` as a tagged object: `{ "PtyNotFound": "..."}`.
 * We sniff the tag rather than parsing the message so changes to the
 * human-readable string never break frontend branching.
 */
export function classifyHeadlessError(err: unknown): HeadlessErrorKind {
  if (typeof err === "object" && err !== null) {
    if ("StreamSessionBusy" in err) return "session_busy";
    if ("PtyNotFound" in err) return "not_found";
    if ("PtySpawnFailed" in err) return "spawn_failed";
    if ("CliNotFound" in err) return "spawn_failed";
  }
  return "other";
}
