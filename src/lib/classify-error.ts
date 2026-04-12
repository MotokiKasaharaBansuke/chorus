/**
 * Classify a Tauri backend error for stream session operations.
 *
 * Tauri 2 serializes `AppError` (a Rust enum with `#[derive(Serialize)]`)
 * using serde's default externally-tagged representation:
 *   { PtyNotFound: "some-id" }
 *   { StreamSessionBusy: "Already processing a message" }
 *
 * We inspect the object key to classify — this is stable as long as
 * the Rust enum variant names don't change.
 */

type StreamErrorKind = "not_found" | "busy" | "other";

export function classifyStreamError(error: unknown): StreamErrorKind {
  if (typeof error === "object" && error !== null) {
    if ("PtyNotFound" in error) return "not_found";
    if ("StreamSessionBusy" in error) return "busy";
  }
  return "other";
}
