/**
 * Wire types shared with `src-tauri/src/headless/event.rs`.
 *
 * Tag values use **dash-separated kebab-case** to match the existing PTY
 * payload conventions (`pty-output`, `pty-exit`, `stream-event-batch`).
 * Field names are camelCase because the Rust side uses
 * `#[serde(rename_all = "camelCase")]`.
 *
 * Keep this file in sync with the Rust enum — Rust is the source of truth.
 */

/** Tab identifier (1:1 with headless session id). */
export type TabId = string;

/** Chorus-side request id (UUID v4). */
export type RequestId = string;

/** Assistant message id (issued by the upstream CLI). */
export type MessageId = string;

/** Tool invocation id (issued by the upstream CLI). */
export type ToolUseId = string;

/** Lifecycle state of a session. Drives busy spinners, stop buttons, etc. */
export type SessionStatus = "idle" | "thinking" | "running" | "error";

/** Discriminator for an `Error`-status reason. */
export type ErrorKind =
  | "cli_incompatible"
  | "agent_crashed"
  | "rate_limited"
  | "network"
  | "protocol_violation"
  | "other";

/** Why an assistant message ended. */
export type FinishReason = "stop" | "cancel" | "error";

/** Token accounting for a turn. Mirrors Rust `UsageReport`. */
export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Detail attached to a `rate-limit` event. */
export interface RateLimitDetail {
  resetAt?: number;
  retryAfterMs: number;
}

/** Wire event from the per-tab Tauri channel `headless:<tabId>:event`. */
export type HeadlessEvent =
  | {
      type: "message-delta";
      tabId: TabId;
      messageId: MessageId;
      index: number;
      delta: string;
    }
  | {
      type: "message-complete";
      tabId: TabId;
      messageId: MessageId;
      finishReason: FinishReason;
    }
  | {
      type: "tool-use";
      tabId: TabId;
      messageId: MessageId;
      toolUseId: ToolUseId;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-result";
      tabId: TabId;
      toolUseId: ToolUseId;
      output: string;
      isError: boolean;
    }
  | { type: "usage"; tabId: TabId; usage: UsageReport }
  | {
      type: "status";
      tabId: TabId;
      status: SessionStatus;
      errorKind?: ErrorKind;
      message?: string;
    }
  | { type: "rate-limit"; tabId: TabId; detail: RateLimitDetail }
  | { type: "session-id"; tabId: TabId; sessionId: string }
  | { type: "unknown"; tabId: TabId; raw: unknown };

/**
 * Compile-time exhaustive table of `HeadlessEvent` discriminator values.
 *
 * `satisfies Record<HeadlessEvent["type"], true>` makes the TypeScript
 * compiler reject this file the day a new variant is added to the union
 * without also being listed here — far better than discovering a missed
 * case at runtime via the `unknown` fallback.
 */
const KNOWN_HEADLESS_EVENT_TYPES = {
  "message-delta": true,
  "message-complete": true,
  "tool-use": true,
  "tool-result": true,
  usage: true,
  status: true,
  "rate-limit": true,
  "session-id": true,
  unknown: true,
} satisfies Record<HeadlessEvent["type"], true>;

/** Type guard: discriminate by the `type` tag. */
export function isHeadlessEvent(value: unknown): value is HeadlessEvent {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" && t in KNOWN_HEADLESS_EVENT_TYPES;
}

/** Per-tab session state held by the frontend store. */
export interface HeadlessSessionState {
  tabId: TabId;
  status: SessionStatus;
  errorKind?: ErrorKind;
  errorMessage?: string;
  messages: HeadlessMessage[];
  usage: UsageReport;
  rateLimit?: RateLimitDetail;
  /** Upstream `claude` session id reported by the backend via the
   *  `session-id` event. Persisted to localStorage so a subsequent
   *  app launch can pass it back as `resumeSessionAt` and reattach
   *  the conversation. */
  upstreamSessionId?: string;
}

/** A user or assistant turn in the conversation, derived from the wire stream. */
export type HeadlessMessage =
  | {
      role: "user";
      id: RequestId;
      text: string;
      sentAt: number;
    }
  | {
      role: "assistant";
      id: MessageId;
      text: string;
      toolCalls: HeadlessToolCall[];
      finishReason?: FinishReason;
      streaming: boolean;
    };

/** A tool invocation pair: the assistant's call and its result. */
export interface HeadlessToolCall {
  toolUseId: ToolUseId;
  name: string;
  input: unknown;
  result?: HeadlessToolResult;
}

export interface HeadlessToolResult {
  output: string;
  isError: boolean;
}

/** Frontend-visible payload for `spawn_headless`. Matches Rust struct. */
export interface SpawnHeadlessRequest {
  tabId: TabId;
  cliType: "claude-code" | "codex";
  mode?: "default" | "plan" | "dangerously-skip-permissions";
  cwd: string;
  model?: string;
  extraEnv?: Record<string, string>;
  resumeSessionAt?: string;
  forkSession?: boolean;
}

export interface InspectHeadlessLockResponse {
  ageSeconds: number | null;
}
