import type { ChatMessage, ChatBlock } from "../types";

/** Manages streaming state for a single chat session (Claude Code or Codex) */
export class StreamParser {
  private messages: ChatMessage[] = [];
  private listeners: Array<(messages: ChatMessage[]) => void> = [];
  private initialized = false;

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

  /** Load past session from JSONL lines */
  loadSession(lines: string[]) {
    this.messages = [];
    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        const type = data.type as string;
        if (type === "user") {
          const msg = data.message as Record<string, unknown> | undefined;
          if (msg?.role === "user") {
            const content = msg.content;
            if (typeof content === "string") {
              this.messages.push({
                role: "user",
                blocks: [{ kind: "text", text: content }],
                isStreaming: false,
              });
            } else if (Array.isArray(content)) {
              const texts: string[] = [];
              for (const b of content) {
                if ((b as Record<string, unknown>).type === "text") {
                  const t = (b as Record<string, unknown>).text as string;
                  if (t && !t.startsWith("<")) texts.push(t);
                }
              }
              if (texts.length > 0) {
                this.messages.push({
                  role: "user",
                  blocks: [{ kind: "text", text: texts.join("\n") }],
                  isStreaming: false,
                });
              }
            }
          }
        } else if (type === "assistant") {
          this.handleAssistant(data);
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
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const type = data.type as string;

    switch (type) {
      case "system":
        this.handleSystem(data);
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

  private handleSystem(_data: Record<string, unknown>) {
    if (!this.initialized) {
      this.initialized = true;
    }
  }

  private handleAssistant(data: Record<string, unknown>) {
    const message = data.message as Record<string, unknown> | undefined;
    if (!message) return;

    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;

    const blocks: ChatBlock[] = [];
    const model = message.model as string | undefined;

    for (const block of content) {
      switch (block.type) {
        case "text": {
          const text = block.text as string;
          if (text) {
            blocks.push({ kind: "text", text });
          }
          break;
        }
        case "thinking": {
          const thinking = block.thinking as string;
          if (thinking) {
            blocks.push({ kind: "thinking", text: thinking, isStreaming: false });
          }
          break;
        }
        case "tool_use": {
          const input = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
          blocks.push({
            kind: "tool_use",
            toolName: block.name as string,
            toolId: block.id as string,
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
            toolId: (block.tool_use_id as string) ?? "",
            output,
            isError: (block.is_error as boolean) ?? false,
          });
          break;
        }
      }
    }

    if (blocks.length > 0) {
      this.messages.push({
        role: "assistant",
        blocks,
        isStreaming: false,
        model,
      });
      this.notify();
    }
  }

  private handleResult(data: Record<string, unknown>) {
    // Update last assistant message with cost/token info
    const lastMsg = [...this.messages].reverse().find(m => m.role === "assistant");
    if (lastMsg) {
      lastMsg.costUsd = data.total_cost_usd as number | undefined;
      lastMsg.durationMs = data.duration_ms as number | undefined;
      const usage = data.usage as Record<string, number> | undefined;
      if (usage) {
        lastMsg.inputTokens = usage.input_tokens;
        lastMsg.outputTokens = usage.output_tokens;
      }
    }
    this.notify();
  }

  private handleTurnComplete(_data: Record<string, unknown>) {
    // Mark last assistant message as complete
    const lastMsg = [...this.messages].reverse().find(m => m.role === "assistant");
    if (lastMsg) {
      lastMsg.isStreaming = false;
    }
    this.notify();
  }

  private handleUserToolResult(data: Record<string, unknown>) {
    // Tool execution result comes as a "user" message with tool_result content
    const message = data.message as Record<string, unknown> | undefined;
    const toolResult = data.tool_use_result as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;

    if (!content) return;

    // Find the last assistant message to attach tool results
    const lastAssistant = [...this.messages].reverse().find(m => m.role === "assistant");
    if (!lastAssistant) return;

    const newBlocks: ChatBlock[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        const toolId = block.tool_use_id as string;
        let output = "";

        // Prefer tool_use_result.stdout for cleaner output
        if (toolResult?.stdout) {
          output = toolResult.stdout as string;
        } else if (typeof block.content === "string") {
          output = block.content;
        } else {
          output = JSON.stringify(block.content, null, 2);
        }

        newBlocks.push({
          kind: "tool_result",
          toolId,
          output,
          isError: (block.is_error as boolean) ?? false,
        });
      }
    }

    if (newBlocks.length > 0) {
      // Create new blocks array for reactivity
      lastAssistant.blocks = [...lastAssistant.blocks, ...newBlocks];
      this.notify();
    }
  }

  private handleStderr(data: Record<string, unknown>) {
    const text = data.text as string;
    if (!text) return;

    // Show stderr as a system message
    this.messages.push({
      role: "system",
      blocks: [{ kind: "stderr", text }],
      isStreaming: false,
    });
    this.notify();
  }
}
