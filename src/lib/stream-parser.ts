import type { ChatMessage, ChatBlock } from "../types";

/** Manages streaming state for a single chat session (Claude Code or Codex) */
export class StreamParser {
  private messages: ChatMessage[] = [];
  private listeners: Array<(messages: ChatMessage[]) => void> = [];

  onUpdate(fn: (messages: ChatMessage[]) => void) {
    this.listeners.push(fn);
  }

  private notify() {
    // Deep copy messages with new block arrays for SolidJS reactivity
    const snapshot = this.messages.map(m => ({
      ...m,
      blocks: [...m.blocks],
    }));
    for (const fn of this.listeners) {
      fn(snapshot);
    }
  }

  getMessages(): ChatMessage[] {
    return [...this.messages];
  }

  /** Load past session from JSONL lines (supports Claude Code and Codex formats) */
  loadSession(lines: string[]) {
    this.messages = [];
    for (const line of lines) {
      try {
        const data = JSON.parse(line) as Record<string, unknown>;
        const type = typeof data.type === "string" ? data.type : null;
        if (!type) continue;

        // --- Claude Code format ---
        if (type === "user") {
          const rawMsg = data.message;
          const msg = typeof rawMsg === "object" && rawMsg !== null
            ? rawMsg as Record<string, unknown>
            : undefined;
          if (msg?.role === "user") {
            const content = msg.content;
            if (typeof content === "string") {
              this.messages.push({ role: "user", blocks: [{ kind: "text", text: content }], isStreaming: false });
            } else if (Array.isArray(content)) {
              const texts: string[] = [];
              for (const b of content) {
                const block = typeof b === "object" && b !== null ? b as Record<string, unknown> : undefined;
                if (block?.type === "text") {
                  const t = typeof block.text === "string" ? block.text : "";
                  if (t && !t.startsWith("<")) texts.push(t);
                }
              }
              if (texts.length > 0) {
                this.messages.push({ role: "user", blocks: [{ kind: "text", text: texts.join("\n") }], isStreaming: false });
              }
            }
          }
        } else if (type === "assistant") {
          this.handleAssistant(data);

        // --- Codex format ---
        } else if (type === "event_msg") {
          const rawPayload = data.payload;
          const payload = typeof rawPayload === "object" && rawPayload !== null
            ? rawPayload as Record<string, unknown>
            : undefined;
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

  addUserMessage(text: string) {
    this.messages.push({
      role: "user",
      blocks: [{ kind: "text", text }],
      isStreaming: false,
    });
    this.notify();
  }

  /** Process a single NDJSON line from Claude Code stream-json */
  processLine(raw: string) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof data.type === "string" ? data.type : null;
    if (!type) return;

    switch (type) {
      case "system":
        // no-op: system events carry no display-relevant data
        break;
      case "assistant":
        this.handleAssistant(data);
        break;
      case "result":
        this.handleResult(data);
        break;
      case "user":
        this.handleUserToolResult(data);
        break;
      case "turn_complete":
        this.handleTurnComplete(data);
        break;
      case "stderr":
        this.handleStderr(data);
        break;
      case "rate_limit_event":
        // ignore
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
    const rawMessage = data.message;
    const message = typeof rawMessage === "object" && rawMessage !== null
      ? rawMessage as Record<string, unknown>
      : undefined;
    if (!message) return;

    const rawContent = message.content;
    const content = Array.isArray(rawContent)
      ? rawContent as Array<Record<string, unknown>>
      : undefined;
    if (!content) return;

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
          const input = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
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
          const output = typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content, null, 2);
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
      this.notify();
    }
  }

  private handleResult(data: Record<string, unknown>) {
    const idx = this.findLastAssistantIdx();
    if (idx === -1) { this.notify(); return; }

    const rawUsage = data.usage;
    const usageObj = typeof rawUsage === "object" && rawUsage !== null
      ? rawUsage as Record<string, unknown>
      : undefined;

    this.messages[idx] = {
      ...this.messages[idx],
      costUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
      durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
      inputTokens: typeof usageObj?.input_tokens === "number" ? usageObj.input_tokens : undefined,
      outputTokens: typeof usageObj?.output_tokens === "number" ? usageObj.output_tokens : undefined,
    };
    this.notify();
  }

  private handleTurnComplete(_data: Record<string, unknown>) {
    const idx = this.findLastAssistantIdx();
    if (idx === -1) { this.notify(); return; }
    this.messages[idx] = { ...this.messages[idx], isStreaming: false };
    this.notify();
  }

  private handleUserToolResult(data: Record<string, unknown>) {
    const rawMessage = data.message;
    const message = typeof rawMessage === "object" && rawMessage !== null
      ? rawMessage as Record<string, unknown>
      : undefined;
    const rawToolResult = data.tool_use_result;
    const toolResult = typeof rawToolResult === "object" && rawToolResult !== null
      ? rawToolResult as Record<string, unknown>
      : undefined;
    const rawContent = message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent as Array<Record<string, unknown>>
      : undefined;

    if (!content) return;

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
          output = JSON.stringify(block.content, null, 2);
        }

        newBlocks.push({ kind: "tool_result", toolId, output, isError: block.is_error === true });
      }
    }

    if (newBlocks.length > 0) {
      this.messages[idx] = {
        ...this.messages[idx],
        blocks: [...this.messages[idx].blocks, ...newBlocks],
      };
      this.notify();
    }
  }

  private handleStderr(data: Record<string, unknown>) {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text) return;

    this.messages.push({
      role: "system",
      blocks: [{ kind: "stderr", text }],
      isStreaming: false,
    });
    this.notify();
  }
}
