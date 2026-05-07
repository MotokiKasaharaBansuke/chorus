import { createSignal } from "solid-js";

import { writeHeadlessInput } from "../../lib/headless/commands";
import { useHeadlessStore } from "../../stores/headless-store";
import type { TabId } from "../../types/headless";

import styles from "./headless-panel.module.css";

interface HeadlessInputProps {
  tabId: TabId;
  /** Disable while the agent is producing output. */
  disabled: boolean;
}

/** 256 KiB. Matches `MAX_USER_TEXT_BYTES` in
 *  `src-tauri/src/commands/headless_commands.rs` — keep the two in sync.
 *  Anything larger is far beyond a normal user turn and risks IPC /
 *  stdin head-of-line blocking. */
const MAX_INPUT_BYTES = 256 * 1024;

const TEXT_ENCODER = new TextEncoder();

function utf8ByteLength(value: string): number {
  return TEXT_ENCODER.encode(value).length;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Composer for user input.
 *
 * Submit semantics intentionally mirror `chat-input.tsx`:
 *   - Enter (without Shift) submits
 *   - Shift+Enter inserts a newline
 *   - During IME composition (`isComposing`) the Enter key never submits,
 *     and the 50 ms guard after `compositionend` swallows the trailing
 *     Enter that some IMEs deliver as a separate keydown
 *
 * Errors are surfaced via the headless store's `status` row rather than
 * alert dialogs so they fold into the same UI as backend-driven errors.
 */
export function HeadlessInput(props: HeadlessInputProps) {
  const store = useHeadlessStore();
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [isComposing, setIsComposing] = createSignal(false);
  let isCompositionJustEnded = false;

  const submit = async () => {
    const value = text().trim();
    if (!value || props.disabled || busy()) return;
    if (utf8ByteLength(value) > MAX_INPUT_BYTES) {
      store.applyEvent({
        type: "status",
        tabId: props.tabId,
        status: "error",
        errorKind: "other",
        message: `input exceeds ${MAX_INPUT_BYTES} bytes`,
      });
      return;
    }
    setBusy(true);
    try {
      const requestId = await writeHeadlessInput(props.tabId, value);
      store.appendUserMessage(props.tabId, requestId, value);
      setText("");
    } catch (e) {
      console.error("[headless] write failed", e);
      store.applyEvent({
        type: "status",
        tabId: props.tabId,
        status: "error",
        errorKind: "other",
        message: describeError(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (isComposing() || isCompositionJustEnded) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div class={styles.inputArea}>
      <textarea
        class={styles.inputBox}
        rows="2"
        placeholder="Send a message…"
        value={text()}
        disabled={props.disabled || busy()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => {
          setIsComposing(false);
          isCompositionJustEnded = true;
          setTimeout(() => {
            isCompositionJustEnded = false;
          }, 50);
        }}
      />
      <button
        class={styles.sendButton}
        type="button"
        disabled={props.disabled || busy() || text().trim() === ""}
        onClick={() => void submit()}
      >
        Send
      </button>
    </div>
  );
}
