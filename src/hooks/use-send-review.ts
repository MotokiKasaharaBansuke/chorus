import { createSignal } from "solid-js";
import { sendMessage as sendMessageCmd } from "../lib/commands";
import { effectivePtyId } from "../types";
import type { Tab, ChatMessage } from "../types";
import { useTabStore } from "../stores/tab-store";

const MAX_REVIEW_TEXT_LENGTH = 50_000;

export function extractLastAssistantText(messages: ReadonlyArray<ChatMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const textParts = messages[i].blocks
      .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
      .map((b) => b.text);
    if (textParts.length > 0) return textParts.join("\n");
  }
  return null;
}

function truncateWithNotice(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Truncated: review text exceeded ${max} characters]`;
}

interface UseSendReviewParams {
  tab: Tab;
  messages: () => ReadonlyArray<ChatMessage>;
  addMessage: (text: string) => void;
}

export function useSendReview({ tab, messages, addMessage }: UseSendReviewParams) {
  const store = useTabStore();
  const [isSending, setIsSending] = createSignal(false);

  const hasSourceTab = () => Boolean(tab.sourceTabId);

  async function sendToSource(): Promise<void> {
    if (isSending()) return;
    const sourceId = tab.sourceTabId;
    if (!sourceId) return;

    setIsSending(true);
    try {
      const sourceTab = store.getTab(sourceId);
      if (!sourceTab) {
        addMessage("[Source tab no longer exists.]");
        return;
      }

      const rawText = extractLastAssistantText(messages());
      if (!rawText) {
        addMessage("[No review result to send.]");
        return;
      }

      const reviewText = truncateWithNotice(rawText, MAX_REVIEW_TEXT_LENGTH);
      const prompt = [
        "Here is the review result from another session:",
        "",
        "```",
        reviewText,
        "```",
        "",
        "Please address the issues found in this review.",
      ].join("\n");

      const sourcePtyId = effectivePtyId(sourceTab);
      await sendMessageCmd(sourcePtyId, prompt);
      store.updateStatus(sourceTab.id, "running");
      store.setActiveTab(sourceTab.id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      addMessage(`[Failed to send review to source tab: ${msg}]`);
    } finally {
      setIsSending(false);
    }
  }

  return { sendToSource, isSending, hasSourceTab };
}
