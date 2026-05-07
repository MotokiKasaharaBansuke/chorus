import { For } from "solid-js";

import type { HeadlessMessage } from "../../../types/headless";

import { AssistantMessage } from "./assistant-message";
import { UserMessage } from "./user-message";

interface MessageListProps {
  messages: readonly HeadlessMessage[];
}

/**
 * Sequential rendering of the conversation.
 *
 * Phase 2 keeps the list non-virtualised because realistic Claude
 * conversations are well under 200 messages — far below the threshold
 * where SolidJS' fine-grained reactivity meaningfully suffers. If a
 * future workload makes the list expensive, plug `@tanstack/solid-virtual`
 * here without touching the parent.
 */
export function MessageList(props: MessageListProps) {
  return (
    <For each={props.messages}>
      {(msg) => {
        if (msg.role === "user") {
          return <UserMessage text={msg.text} />;
        }
        return <AssistantMessage message={msg} />;
      }}
    </For>
  );
}
