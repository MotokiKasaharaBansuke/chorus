/**
 * Adapt the headless store's session view into the `ChatMessage[]` shape
 * that `<MessageBubble>` (the PTY chat panel's message renderer) expects.
 *
 * The two sides have intentionally different domain models:
 *
 * - `HeadlessSessionState.messages` is event-driven and minimal —
 *   `{ role, text, toolCalls, streaming, ... }` matching the upstream
 *   stream-json envelope shape.
 * - `ChatMessage` is render-driven — a flat `blocks[]` of typed
 *   building blocks (`text`, `tool_use`, `tool_result`, etc.) that
 *   `MessageBubble` walks once and renders inline.
 *
 * Keeping the renderer ignorant of which engine produced the message
 * lets us reuse PTY's timeline / dot / Edit-diff / TodoWrite UI for
 * headless without copying a single styling rule.
 *
 * Tool calls fan out into a `tool_use` block followed by an optional
 * `tool_result` block; `MessageBubble` pairs them up by `toolId` and
 * renders the unified card.
 */
import type { ChatBlock, ChatMessage } from "../../types";
import type {
  HeadlessMessage,
  HeadlessSessionState,
} from "../../types/headless";

/**
 * Build the renderable message list for a single headless session.
 * Returns an empty array (not `null`) when the session is missing so
 * the caller can render an "empty state" without a guard.
 */
export function adaptHeadlessMessages(
  session: HeadlessSessionState | undefined,
): ChatMessage[] {
  if (!session) return [];
  const messages = session.messages.map(adaptMessage);
  // Surface error / rate-limit state as a trailing system row. Plays
  // the same role as the chat-panel's red toast — keeps the failure
  // mode visible without a separate status bar (the previous
  // standalone usage-bar component owned this UX before Phase 1h).
  const systemRow = buildSystemRow(session);
  if (systemRow) messages.push(systemRow);
  return messages;
}

function adaptMessage(msg: HeadlessMessage): ChatMessage {
  if (msg.role === "user") {
    const blocks: ChatBlock[] = [];
    if (msg.text) blocks.push({ kind: "text", text: msg.text });
    if (msg.images) {
      for (const img of msg.images) {
        blocks.push({ kind: "image", path: img.path, name: img.name });
      }
    }
    return { role: "user", blocks, isStreaming: false };
  }

  const blocks: ChatBlock[] = [];
  if (msg.text) {
    blocks.push({ kind: "text", text: msg.text });
  }
  for (const call of msg.toolCalls) {
    blocks.push({
      kind: "tool_use",
      toolName: call.name,
      toolId: call.toolUseId,
      input: stringifyToolInput(call.input),
      // PTY's `MessageBubble` flips the tool annotation to "running"
      // when this is `true` — fits "result has not yet arrived".
      isStreaming: !call.result,
    });
    if (call.result) {
      blocks.push({
        kind: "tool_result",
        toolId: call.toolUseId,
        output: call.result.output,
        isError: call.result.isError,
      });
    }
  }

  return {
    role: "assistant",
    blocks,
    isStreaming: msg.streaming,
  };
}

/**
 * Tool input is `unknown` on the wire (claude can pass any JSON object).
 * `MessageBubble` expects a string and `JSON.parse`s it for typed tools
 * (`Edit`, `TodoWrite`, etc.), so we serialise here and let the bubble
 * decide how to render.
 */
function stringifyToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    // `input` could be a circular structure or contain `BigInt` —
    // defensive default so the UI still renders the surrounding tool
    // card instead of crashing the whole panel.
    return String(input);
  }
}

function buildSystemRow(session: HeadlessSessionState): ChatMessage | null {
  const text = formatSystemRowText(session);
  if (!text) return null;
  return {
    role: "system",
    blocks: [{ kind: "text", text }],
    isStreaming: false,
  };
}

/**
 * Pick the most informative single-line summary of the session's
 * out-of-band state. Order of priority: explicit error → rate-limit
 * advisory → nothing. The dedupe between `errorKind` and `errorMessage`
 * avoids strings like `"rate_limited: rate_limited"` when the message
 * just echoes the kind.
 */
function formatSystemRowText(session: HeadlessSessionState): string | null {
  if (session.status === "error") {
    const kind = session.errorKind;
    const message = session.errorMessage;
    if (kind && message && kind !== message) return `${kind}: ${message}`;
    if (message) return message;
    if (kind) return kind;
    return "unknown error";
  }
  if (session.rateLimit) {
    const { retryAfterMs, resetAt } = session.rateLimit;
    if (retryAfterMs > 0) {
      return `Rate limited — retry in ${formatDuration(retryAfterMs)}`;
    }
    if (resetAt) {
      return `Rate limited — resets at ${new Date(resetAt * 1000).toLocaleTimeString()}`;
    }
    return "Rate limited";
  }
  return null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}
