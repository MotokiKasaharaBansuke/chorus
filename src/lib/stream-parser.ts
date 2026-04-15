import type { ChatMessage, ChatBlock } from "../types";
import type { RateLimitInfo } from "../types/usage";

type StreamingStatus = "streaming" | "idle";

const VALID_RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set<RateLimitInfo["status"]>(["allowed", "allowed_warning", "rejected"]);
const VALID_RATE_LIMIT_TYPES: ReadonlySet<string> = new Set<RateLimitInfo["rateLimitType"]>(["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "overage"]);

function isRateLimitStatus(s: string): s is RateLimitInfo["status"] {
  return VALID_RATE_LIMIT_STATUSES.has(s);
}

function isRateLimitType(s: string): s is RateLimitInfo["rateLimitType"] {
  return VALID_RATE_LIMIT_TYPES.has(s);
}

/** Manages streaming state for a single chat session (Claude Code or Codex) */
export class StreamParser {
  private messages: ChatMessage[] = [];
  private listeners: Array<(messages: ChatMessage[]) => void> = [];
  private statusListeners: Array<(status: StreamingStatus) => void> = [];
  private rateLimitListeners: Array<(info: RateLimitInfo) => void> = [];
  private isRafScheduled = false;

  onUpdate(fn: (messages: ChatMessage[]) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }

  /** Register a callback for streaming status changes.
   *  Fires "streaming" on init, "idle" on result/turn_complete.
   *  Returns an unsubscribe function. */
  onStatusChange(fn: (status: StreamingStatus) => void): () => void {
    this.statusListeners.push(fn);
    return () => { this.statusListeners = this.statusListeners.filter(l => l !== fn); };
  }

  onRateLimit(fn: (info: RateLimitInfo) => void): () => void {
    this.rateLimitListeners.push(fn);
    return () => { this.rateLimitListeners = this.rateLimitListeners.filter(l => l !== fn); };
  }

  private buildSnapshot(): ChatMessage[] {
    return this.messages.map(m => ({ ...m, blocks: [...m.blocks] }));
  }

  /** Immediate notify — used for user-initiated actions (send message, load session, etc.) */
  private notify() {
    const snapshot = this.buildSnapshot();
    for (const fn of this.listeners) fn(snapshot);
  }

  /** rAF-batched notify — used during streaming so multiple events per frame produce one DOM update.
   *  Falls back to immediate notify in environments without requestAnimationFrame (e.g. tests). */
  private notifyBatched() {
    if (typeof requestAnimationFrame === "undefined") {
      this.notify();
      return;
    }
    if (this.isRafScheduled) return;
    this.isRafScheduled = true;
    requestAnimationFrame(() => {
      this.isRafScheduled = false;
      const snapshot = this.buildSnapshot();
      for (const fn of this.listeners) fn(snapshot);
    });
  }

  private notifyStatus(status: StreamingStatus) {
    for (const fn of this.statusListeners) fn(status);
  }

  /** Narrows `unknown` to a plain object record, or returns undefined.
   *  The `as` cast is safe: we verify `typeof === "object" && non-null` before casting. */
  private toRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Load past session from JSONL lines (supports Claude Code and Codex formats) */
  loadSession(lines: string[]) {
    this.messages = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        const data = this.toRecord(parsed);
        if (!data) continue;
        const type = typeof data.type === "string" ? data.type : null;
        if (!type) continue;

        // --- Claude Code format ---
        if (type === "user") {
          const msg = this.toRecord(data.message);
          if (msg?.role === "user") {
            const content = msg.content;
            if (typeof content === "string") {
              this.messages.push({ role: "user", blocks: [{ kind: "text", text: content }], isStreaming: false });
            } else if (Array.isArray(content)) {
              // Extract user text (skip XML context blocks)
              const texts: string[] = [];
              for (const b of content) {
                const block = this.toRecord(b);
                if (block?.type === "text") {
                  const t = typeof block.text === "string" ? block.text : "";
                  if (t && !t.startsWith("<")) texts.push(t);
                }
              }
              if (texts.length > 0) {
                this.messages.push({ role: "user", blocks: [{ kind: "text", text: texts.join("\n") }], isStreaming: false });
              }

              // Extract tool_results and attach to the last assistant message
              const lastAssistantIdx = this.findLastAssistantIdx();
              if (lastAssistantIdx !== -1) {
                const resultBlocks: ChatBlock[] = [];
                for (const b of content) {
                  const block = this.toRecord(b);
                  if (block?.type === "tool_result") {
                    const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
                    let output = "";
                    if (typeof block.content === "string") {
                      output = block.content;
                    } else if (Array.isArray(block.content)) {
                      const textParts = (block.content as unknown[])
                        .map(c => this.toRecord(c))
                        .filter((c): c is Record<string, unknown> => c?.type === "text")
                        .map(c => typeof c.text === "string" ? c.text : "");
                      output = textParts.join("\n");
                    } else {
                      try { output = JSON.stringify(block.content, null, 2); } catch { output = ""; }
                    }
                    if (output) {
                      resultBlocks.push({ kind: "tool_result", toolId, output, isError: block.is_error === true });
                    }
                  }
                }
                if (resultBlocks.length > 0) {
                  this.messages[lastAssistantIdx] = {
                    ...this.messages[lastAssistantIdx],
                    blocks: [...this.messages[lastAssistantIdx].blocks, ...resultBlocks],
                  };
                }
              }
            }
          }
        } else if (type === "assistant") {
          this.handleAssistant(data);

        // --- Codex format ---
        } else if (type === "event_msg") {
          const payload = this.toRecord(data.payload);
          if (!payload) continue;
          const ptype = typeof payload.type === "string" ? payload.type : null;
          if (ptype === "user_message") {
            const text = typeof payload.message === "string" ? payload.message.trim() : "";
            if (text && !text.startsWith("/model")) {
              this.messages.push({ role: "user", blocks: [{ kind: "text", text }], isStreaming: false });
            }
          } else if (ptype === "agent_message") {
            const text = typeof payload.message === "string" ? payload.message.trim() : "";
            if (text) {
              this.messages.push({ role: "assistant", blocks: [{ kind: "text", text }], isStreaming: false });
            }
          }
        }
      } catch { /* skip bad lines */ }
    }
    this.notify();
  }

  /** @param images Caller MUST validate paths via isValidTempImagePath before passing. */
  addUserMessage(text: string, images?: ReadonlyArray<{ path: string; name: string }>) {
    const imageBlocks: ChatBlock[] = (images ?? []).map(img => ({
      kind: "image" as const,
      path: img.path,
      name: img.name,
    }));
    this.messages.push({
      role: "user",
      blocks: [...imageBlocks, { kind: "text", text }],
      isStreaming: false,
    });
    this.notify();
  }

  addInterrupted() {
    this.messages.push({
      role: "system",
      blocks: [{ kind: "stderr", text: "Interrupted" }],
      isStreaming: false,
    });
    this.notify();
  }

  /** Process a single NDJSON line from Claude Code stream-json */
  processLine(raw: string) {
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      const obj = this.toRecord(parsed);
      if (!obj) return;
      data = obj;
    } catch {
      return;
    }

    const type = typeof data.type === "string" ? data.type : null;
    if (!type) return;

    switch (type) {
      case "system":
        if (data.subtype === "init") this.notifyStatus("streaming");
        break;
      case "assistant":
        this.handleAssistant(data);
        break;
      case "result":
        this.handleResult(data);
        this.notifyStatus("idle");
        break;
      case "user":
        this.handleUserToolResult(data);
        break;
      case "turn_complete":
        this.handleTurnComplete(data);
        this.notifyStatus("idle");
        break;
      case "stderr":
        this.handleStderr(data);
        break;
      case "rate_limit_event":
        this.handleRateLimit(data);
        break;
    }
  }

  private findLastAssistantIdx(): number {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") return i;
    }
    return -1;
  }

  private handleAssistant(data: Record<string, unknown>) {
    const message = this.toRecord(data.message);
    if (!message) return;

    const rawContent = message.content;
    if (!Array.isArray(rawContent)) return;
    const content = rawContent
      .map(b => this.toRecord(b))
      .filter((b): b is Record<string, unknown> => b !== undefined);

    const blocks: ChatBlock[] = [];
    const model = typeof message.model === "string" ? message.model : undefined;

    for (const block of content) {
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          if (text) blocks.push({ kind: "text", text });
          break;
        }
        case "thinking": {
          const thinking = typeof block.thinking === "string" ? block.thinking : "";
          if (thinking) blocks.push({ kind: "thinking", text: thinking, isStreaming: false });
          break;
        }
        case "tool_use": {
          let input: string;
          if (typeof block.input === "string") {
            input = block.input;
          } else {
            try { input = JSON.stringify(block.input, null, 2); } catch { input = "[unparseable]"; }
          }
          blocks.push({
            kind: "tool_use",
            toolName: typeof block.name === "string" ? block.name : "",
            toolId: typeof block.id === "string" ? block.id : "",
            input,
            isStreaming: false,
          });
          break;
        }
        case "tool_result": {
          let output: string;
          if (typeof block.content === "string") {
            output = block.content;
          } else {
            try { output = JSON.stringify(block.content, null, 2); } catch { output = "[unparseable]"; }
          }
          blocks.push({
            kind: "tool_result",
            toolId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            output,
            isError: block.is_error === true,
          });
          break;
        }
      }
    }

    if (blocks.length > 0) {
      this.messages.push({ role: "assistant", blocks, isStreaming: false, model });
      this.notifyBatched();
    }
  }

  private handleResult(data: Record<string, unknown>) {
    const idx = this.findLastAssistantIdx();
    if (idx === -1) { this.notifyBatched(); return; }

    const usageObj = this.toRecord(data.usage);
    this.messages[idx] = {
      ...this.messages[idx],
      costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
      durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
      inputTokens: typeof usageObj?.input_tokens === "number" ? usageObj.input_tokens : undefined,
      outputTokens: typeof usageObj?.output_tokens === "number" ? usageObj.output_tokens : undefined,
    };
    this.notifyBatched();
  }

  private handleTurnComplete(_data: Record<string, unknown>) {
    const idx = this.findLastAssistantIdx();
    if (idx === -1) { this.notifyBatched(); return; }
    this.messages[idx] = { ...this.messages[idx], isStreaming: false };
    this.notifyBatched();
  }

  private handleUserToolResult(data: Record<string, unknown>) {
    const message = this.toRecord(data.message);
    const toolResult = this.toRecord(data.tool_use_result);
    const rawContent = message?.content;
    if (!Array.isArray(rawContent)) return;
    const content = rawContent
      .map(b => this.toRecord(b))
      .filter((b): b is Record<string, unknown> => b !== undefined);

    const idx = this.findLastAssistantIdx();
    if (idx === -1) return;

    const newBlocks: ChatBlock[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        const toolId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        let output = "";

        // Prefer tool_use_result.stdout for cleaner output
        if (typeof toolResult?.stdout === "string") {
          output = toolResult.stdout;
        } else if (typeof block.content === "string") {
          output = block.content;
        } else {
          try { output = JSON.stringify(block.content, null, 2); } catch { output = "[unparseable]"; }
        }

        newBlocks.push({ kind: "tool_result", toolId, output, isError: block.is_error === true });
      }
    }

    if (newBlocks.length > 0) {
      this.messages[idx] = {
        ...this.messages[idx],
        blocks: [...this.messages[idx].blocks, ...newBlocks],
      };
      this.notifyBatched();
    }
  }

  private handleRateLimit(data: Record<string, unknown>) {
    const raw = this.toRecord(data.rate_limit_info);
    if (!raw) return;

    const status = typeof raw.status === "string" ? raw.status : "";
    const rateLimitType = typeof raw.rateLimitType === "string" ? raw.rateLimitType : "";
    if (!isRateLimitStatus(status) || !isRateLimitType(rateLimitType)) return;

    const info: RateLimitInfo = {
      status,
      rateLimitType,
      utilization: typeof raw.utilization === "number" ? raw.utilization : 0,
      resetsAt: typeof raw.resetsAt === "number" ? raw.resetsAt : 0,
      isUsingOverage: raw.isUsingOverage === true,
    };
    for (const fn of this.rateLimitListeners) fn(info);
  }

  private handleStderr(data: Record<string, unknown>) {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text) return;

    this.messages.push({
      role: "system",
      blocks: [{ kind: "stderr", text }],
      isStreaming: false,
    });
    this.notifyBatched();
  }

}
