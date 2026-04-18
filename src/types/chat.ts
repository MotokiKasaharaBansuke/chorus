/** Image attached to a chat message (preview via temp file path). */
export interface AttachedImage {
  name: string;
  path: string;
  mediaType: string;
}

/** Parsed chat message for rendering */
export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; name: string }
  | { kind: "thinking"; text: string; isStreaming: boolean }
  | { kind: "tool_use"; toolName: string; toolId: string; input: string; isStreaming: boolean }
  | { kind: "tool_result"; toolId: string; output: string; isError: boolean }
  | { kind: "stderr"; text: string };

export interface ChatMessage {
  role: "assistant" | "user" | "system";
  /** Treat as frozen after creation — buildSnapshot() returns shallow copies
   *  that share block references, so in-place mutation (e.g. push) would
   *  corrupt every snapshot. Always spread: `[...msg.blocks, newBlock]`. */
  blocks: readonly ChatBlock[];
  isStreaming: boolean;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
