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
  blocks: ChatBlock[];
  isStreaming: boolean;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
