/**
 * Parse the JSONL session files written by `claude` and `codex` into
 * `HeadlessMessage[]` so the session picker can hydrate a past
 * conversation into the headless store.
 *
 * Why a dedicated module rather than reusing `StreamParser.loadSession`:
 * the PTY parser produces `ChatMessage[]` (render-driven `blocks[]`),
 * whereas headless's domain model is event-driven `HeadlessMessage[]`
 * (`{role, text, toolCalls}`). Going JSONL → HeadlessMessage directly
 * keeps the live-stream and history-load paths converging on the same
 * shape, so `adaptHeadlessMessages` is the single source of truth for
 * rendering.
 *
 * Trust boundary: the JSONL is on-disk content from a previous CLI run
 * — content we control, but parsing must still fail-soft per line so a
 * single corrupt entry does not lose the rest of the conversation.
 */
import type { HeadlessMessage, HeadlessToolCall } from "../../types/headless";

/** Result of parsing a session file. `upstreamSessionId` is `undefined`
 *  when the JSONL did not stamp a usable id (e.g. a partial file or a
 *  malformed `thread.started`); callers should fall back to display-only
 *  hydration in that case. */
export interface ParsedSession {
  messages: HeadlessMessage[];
  upstreamSessionId: string | undefined;
}

/** Same UUID-ish allowlist the Rust IPC enforces in `validate_session_id`.
 *  Mirrored here so we can reject a malformed id at the frontend before
 *  calling `spawnHeadless` and getting a generic IPC error back. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id) && !id.startsWith("-");
}

export function parseSessionJsonl(
  cliType: "claude-code" | "codex",
  lines: readonly string[],
): ParsedSession {
  return cliType === "codex"
    ? parseCodexJsonl(lines)
    : parseClaudeJsonl(lines);
}

// ---------- Claude Code ----------

/** Parse a Claude Code session JSONL. The id lives in the filename
 *  (passed in by the picker) rather than inside the file, so the caller
 *  supplies it via `parseClaudeJsonl(lines).messages` and pairs it with
 *  the picker-provided id. We still surface any `session_id` we observe
 *  for parity with `parseCodexJsonl`. */
function parseClaudeJsonl(lines: readonly string[]): ParsedSession {
  const messages: HeadlessMessage[] = [];
  let upstreamSessionId: string | undefined;
  const counters = { user: 0, assistant: 0 };

  for (const line of lines) {
    const data = safeParseLine(line);
    if (!data) continue;
    if (typeof data.session_id === "string" && isValidSessionId(data.session_id)) {
      upstreamSessionId = data.session_id;
    }

    const type = typeof data.type === "string" ? data.type : null;
    if (type === "user" || type === "human") {
      handleClaudeUser(data, messages, counters);
    } else if (type === "assistant") {
      handleClaudeAssistant(data, messages, counters);
    }
  }

  return { messages, upstreamSessionId };
}

interface HydrationCounters {
  user: number;
  assistant: number;
}

function handleClaudeUser(
  data: Record<string, unknown>,
  messages: HeadlessMessage[],
  counters: HydrationCounters,
): void {
  const message = asRecord(data.message);
  if (!message || message.role !== "user") return;

  const content = message.content;

  if (typeof content === "string") {
    pushUserText(messages, content, counters);
    return;
  }

  if (!Array.isArray(content)) return;

  // Two roles for an array `content`: text blocks (the user typing) and
  // tool_result blocks (system-generated, attached to the *previous*
  // assistant message). We split them so the user row stays text-only
  // and the tool_result lands on the matching toolCall.
  const userTexts: string[] = [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text && !looksLikeIdeContext(text)) userTexts.push(text);
    } else if (block.type === "tool_result") {
      attachClaudeToolResult(block, messages);
    }
  }
  if (userTexts.length > 0) pushUserText(messages, userTexts.join("\n"), counters);
}

/**
 * IDE-context blocks ship from the editor extension (file paths, open
 * tabs, selection ranges, etc.) wrapped in XML-shaped envelopes so the
 * model can locate them. They are noise to a human reader and we drop
 * them on hydration, matching `StreamParser.loadSession`'s behaviour.
 *
 * Conservatively narrow the heuristic to known wrappers — earlier
 * versions stripped *anything* starting with `<`, which silently
 * deleted legitimate code-paste prompts like `<MyComponent>`.
 */
function looksLikeIdeContext(text: string): boolean {
  return /^<(ide-context|system-reminder|local-command-stdout|command-message)\b/.test(
    text,
  );
}

function attachClaudeToolResult(
  block: Record<string, unknown>,
  messages: HeadlessMessage[],
): void {
  const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  if (!toolUseId) return;
  const output = stringifyToolResultContent(block.content);
  const isError = block.is_error === true;

  // Walk back to the most-recent assistant message that owns this tool
  // call; results come after the assistant turn that issued them.
  // First-write-wins on `result`: a tampered JSONL or a fork that
  // re-uses an older tool_use_id must not overwrite the original
  // output (which would let an attacker flip `isError` on past calls).
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const call = msg.toolCalls.find((c) => c.toolUseId === toolUseId);
    if (call) {
      if (!call.result) call.result = { output, isError };
      return;
    }
  }
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return "";
  }
}

function handleClaudeAssistant(
  data: Record<string, unknown>,
  messages: HeadlessMessage[],
  counters: HydrationCounters,
): void {
  const message = asRecord(data.message);
  if (!message) return;

  // Each `message.content` block can be `text` or `tool_use`. We collect
  // text into a single string (mirroring the live-stream `text` field)
  // and turn tool_use blocks into `toolCalls[]` entries.
  const textParts: string[] = [];
  const toolCalls: HeadlessToolCall[] = [];

  if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        const toolUseId = typeof block.id === "string" ? block.id : "";
        const name = typeof block.name === "string" ? block.name : "";
        if (toolUseId && name) {
          toolCalls.push({ toolUseId, name, input: block.input });
        }
      }
    }
  } else if (typeof message.content === "string") {
    textParts.push(message.content);
  }

  // Join with a paragraph separator: bare concatenation glues the
  // tail of one paragraph to the head of the next, which the live
  // stream never produces (deltas naturally include their own
  // whitespace) but multi-text-block historical messages routinely do.
  const text = textParts.join("\n\n");
  if (!text && toolCalls.length === 0) return;

  // Prefer the upstream `message.id` for stable correlation across
  // reloads; fall back to a synthetic id when the file omits it (older
  // claude formats and partial writes both happen in the wild).
  const id =
    typeof message.id === "string" && message.id.length > 0
      ? message.id
      : `hydrated-assistant-${counters.assistant}`;
  counters.assistant += 1;

  messages.push({
    role: "assistant",
    id,
    text,
    toolCalls,
    streaming: false,
    finishReason: "stop",
  });
}

// ---------- Codex ----------

function parseCodexJsonl(lines: readonly string[]): ParsedSession {
  const messages: HeadlessMessage[] = [];
  let upstreamSessionId: string | undefined;
  const counters: HydrationCounters = { user: 0, assistant: 0 };

  for (const line of lines) {
    const data = safeParseLine(line);
    if (!data) continue;
    const type = typeof data.type === "string" ? data.type : null;

    // `thread.started` envelopes carry the upstream `thread_id` Codex
    // requires for `codex exec resume <id>`. The session-picker IPC
    // returns a file path as the row id, so this is the only place we
    // can recover an id that survives `validate_session_id`.
    //
    // First-write-wins: a forked or re-emitted `thread.started` later
    // in the file would point at a different conversation than the
    // one the user picked. Lock onto the first valid id.
    if (type === "thread.started") {
      if (upstreamSessionId) continue;
      const threadId =
        typeof data.thread_id === "string" ? data.thread_id : undefined;
      if (threadId && isValidSessionId(threadId)) {
        upstreamSessionId = threadId;
      }
      continue;
    }

    if (type !== "event_msg") continue;
    const payload = asRecord(data.payload);
    if (!payload) continue;
    const ptype = typeof payload.type === "string" ? payload.type : null;

    if (ptype === "user_message") {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      // Codex's slash commands ship as `user_message`; suppress them in
      // the same spirit as `StreamParser.loadSession` so the UI doesn't
      // surface internal model-change pings as if the user sent them.
      if (text && !text.startsWith("/model")) {
        messages.push({
          role: "user",
          id: `hydrated-user-${counters.user++}`,
          text,
          sentAt: 0,
        });
      }
    } else if (ptype === "agent_message") {
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (text) {
        messages.push({
          role: "assistant",
          id: `hydrated-assistant-${counters.assistant++}`,
          text,
          toolCalls: [],
          streaming: false,
          finishReason: "stop",
        });
      }
    }
  }

  return { messages, upstreamSessionId };
}

// ---------- Shared ----------

function safeParseLine(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pushUserText(
  messages: HeadlessMessage[],
  text: string,
  counters: HydrationCounters,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  messages.push({
    role: "user",
    id: `hydrated-user-${counters.user}`,
    text: trimmed,
    sentAt: 0,
  });
  counters.user += 1;
}
