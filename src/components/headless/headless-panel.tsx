/**
 * One headless agent pane. Visually identical to the PTY chat panel:
 * the same `<MessageBubble>` (timeline rows, dot states, tool cards,
 * Edit diffs, TodoWrite checklists) and the same `<ChatInput>`
 * (mode badge, slash menu, input history, ⌘+Enter, Esc-to-cancel).
 *
 * What headless deliberately drops compared to the PTY panel:
 * - image attachment / paste (claude headless input is text-only)
 * - REPL terminal modal, worktree reset confirm, session picker
 *   (those rely on PTY-side artifacts that headless does not produce)
 * - virtualizer (`@tanstack/solid-virtual`) — kept simple here so the
 *   first parity pass ships small; can be ported in a follow-up if a
 *   long headless session shows scroll-perf issues
 *
 * Subscription lifecycle mirrors `chat-panel.tsx`'s effect pattern:
 * register the listener inside `createEffect`, tear it down in
 * `onCleanup`. Re-running the effect when `tab.id` changes guards
 * against tab reuse via the same panel instance.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  on,
  onCleanup,
  Show,
} from "solid-js";

import { BusySpinner } from "../chat/busy-spinner";
import { ChatInput } from "../chat/chat-input";
import { MessageBubble } from "../chat/message-bubble";
import chatStyles from "../chat/chat-panel.module.css";
import { appendToHistory } from "../chat/input-history";
import { useImageAttachment } from "../../hooks/use-image-attachment";
import {
  cancelHeadlessMessage,
  classifyHeadlessError,
  spawnHeadless,
  writeHeadlessInput,
} from "../../lib/headless/commands";
import { subscribeToHeadlessTab } from "../../lib/headless/event-channel";
import { findStickyPromptText } from "../../lib/find-sticky-prompt-text";
import { STREAM_STALL_MS, STALL_CHECK_INTERVAL_MS, STALL_INTERRUPTED_MESSAGE } from "../../lib/stall-constants";
import { useHeadlessStore } from "../../stores/headless-store";
import type { Tab } from "../../types";

import { adaptHeadlessMessages } from "./adapt-messages";

interface HeadlessPanelProps {
  tab: Tab;
}

export function HeadlessPanel(props: HeadlessPanelProps) {
  const store = useHeadlessStore();
  // Image attachment hook: handles clipboard paste, native drag/drop
  // (via App.tsx's `mlm-image-drop` custom events), and temp-file
  // bookkeeping. Mirrors the chat-panel wiring exactly so the same
  // UX (drop overlay, paste-to-attach) lights up for headless panes.
  const images = useImageAttachment({ tabId: props.tab.id });

  let scrollRef: HTMLDivElement | undefined;

  // While the user has manually scrolled up to read earlier output,
  // auto-scroll is suppressed — otherwise streaming deltas would yank
  // them back to the bottom. Mirrors the chat-panel `isNearBottom`
  // gate but kept as a plain mutable field since the panel does not
  // need to reactively render the value.
  let isNearBottom = true;
  const NEAR_BOTTOM_THRESHOLD_PX = 60;

  function updateIsNearBottom() {
    if (!scrollRef) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef;
    isNearBottom = scrollHeight - scrollTop - clientHeight < NEAR_BOTTOM_THRESHOLD_PX;
  }

  function handleScroll() {
    updateIsNearBottom();
    updateStickyPrompt();
  }

  // Subscribe to the per-tab event channel and ensure the backend
  // session exists. `subscribeToHeadlessTab` calls `registerSession`
  // which hydrates from localStorage if a prior run persisted state;
  // we then attempt a `spawnHeadless` call (idempotent — the backend
  // returns `StreamSessionBusy` when the session is already alive,
  // which we silence). When persisted state carries an
  // `upstreamSessionId`, it rides along as `resumeSessionAt` so
  // claude reattaches to the prior conversation rather than starting
  // a brand-new one.
  createEffect(
    on(
      () => props.tab.id,
      (tabId) => {
        // A reused panel instance now displays a different tab — reset
        // the scroll affordance so we do not inherit the previous
        // tab's "user scrolled up" state.
        isNearBottom = true;
        let unsubscribe: (() => void) | undefined;
        let cancelled = false;
        void subscribeToHeadlessTab(tabId).then(async (off) => {
          if (cancelled) {
            off();
            return;
          }
          unsubscribe = off;
          await ensureBackendSession(tabId);
        });
        onCleanup(() => {
          cancelled = true;
          unsubscribe?.();
        });
      },
    ),
  );

  /// Spawn the backend session if it does not already exist. Safe to
  /// call after every mount: a `session_busy` error means another
  /// owner already has the session alive (the normal case during a
  /// session's lifetime) and we treat it as success.
  async function ensureBackendSession(tabId: string): Promise<void> {
    const persisted = store.sessionFor(tabId);
    const cliType = props.tab.cliConfig.cliType;
    if (cliType !== "claude-code" && cliType !== "codex") return;
    try {
      await spawnHeadless({
        tabId,
        cliType,
        mode: props.tab.cliConfig.mode,
        cwd: props.tab.cliConfig.workingDir,
        model: props.tab.cliConfig.model,
        resumeSessionAt: persisted?.upstreamSessionId,
      });
    } catch (error) {
      const kind = classifyHeadlessError(error);
      if (kind === "session_busy") {
        // Backend already has this session; nothing to do.
        return;
      }
      // Spawn failed for an actionable reason — surface as a status
      // event so the existing system-row renderer shows it.
      store.applyEvent({
        type: "status",
        tabId,
        status: "error",
        errorKind: kind === "spawn_failed" ? "cli_incompatible" : "other",
        message: describeIpcError(error),
      });
    }
  }

  const session = () => store.sessionFor(props.tab.id);
  const messages = createMemo(() => adaptHeadlessMessages(session()));

  const isStreaming = createMemo(() => {
    const status = session()?.status;
    return status === "thinking" || status === "running";
  });

  const [inputHistory, setInputHistory] = createSignal<readonly string[]>([]);

  // Sticky overlay text — the last user message whose top edge has
  // scrolled above the viewport. Mirrors the chat-panel UX so reading
  // long assistant responses keeps the prompt that triggered them
  // visible at the top of the messages container.
  const [stickyPrompt, setStickyPrompt] = createSignal<string | null>(null);

  /// DOM elements for each rendered message, keyed by index. Used by
  /// `updateStickyPrompt` to read `offsetTop` without a virtualizer.
  /// `Map` is rebuilt on every render slot via the ref callbacks
  /// below; entries are removed when the slot is torn down.
  const messageEls = new Map<number, HTMLElement>();

  function updateStickyPrompt() {
    if (!scrollRef) return;
    const list = messages();
    const virtualItems = list.map((_, index) => ({
      index,
      start: messageEls.get(index)?.offsetTop ?? 0,
    }));
    setStickyPrompt(
      findStickyPromptText(list, virtualItems, scrollRef, 0),
    );
  }

  // Sum of text / tool-input / tool-output character lengths across
  // every block. Used purely as a reactive "did the visible text grow?"
  // sentinel for auto-scroll — the exact unit doesn't matter, only
  // that it grows monotonically as deltas stream in. Named `CharCount`
  // (not `Bytes`) because `String.length` returns UTF-16 code units,
  // not byte length.
  const streamingCharCount = createMemo(() => {
    let total = 0;
    for (const message of messages()) {
      for (const block of message.blocks) {
        if (block.kind === "text") total += block.text.length;
        else if (block.kind === "tool_use") total += block.input.length;
        else if (block.kind === "tool_result") total += block.output.length;
      }
    }
    return total;
  });

  // Stall detector: if isStreaming has been true for STREAM_STALL_MS with no
  // message events from the backend, the turn is likely stuck (e.g., a
  // subprocess that will never exit). Cancel the turn and reset status so
  // the user can type again without closing the app.
  // lastActivityAt tracks the last time a message or streaming token arrived,
  // serving as a proxy for "the backend is still producing output".
  let lastActivityAt = 0;

  createEffect(
    on(
      () => [messages().length, streamingCharCount()] as const,
      () => { lastActivityAt = Date.now(); },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!isStreaming()) return;
    lastActivityAt = Date.now();
    const timer = setInterval(() => {
      if (!isStreaming()) { clearInterval(timer); return; }
      if (Date.now() - lastActivityAt >= STREAM_STALL_MS) {
        clearInterval(timer);
        // Always reset the UI regardless of whether the IPC cancel succeeds —
        // the user must be able to type again even if the backend is unresponsive.
        void cancelHeadlessMessage(props.tab.id).catch((e) =>
          console.warn("[headless] stall cancel failed", e),
        );
        store.applyEvent({
          type: "status",
          tabId: props.tab.id,
          status: "error",
          errorKind: "other",
          message: STALL_INTERRUPTED_MESSAGE,
        });
      }
    }, STALL_CHECK_INTERVAL_MS);
    onCleanup(() => clearInterval(timer));
  });

  // Auto-scroll on either layout change (new message / new block) or
  // text-length growth (delta streaming). The `isNearBottom` gate
  // means the user can scroll up to read earlier output without being
  // dragged back. Defer to the next frame so the DOM has reflowed
  // with the new content before we read scrollHeight.
  createEffect(
    on(
      () => [messages().length, streamingCharCount()] as const,
      () => {
        if (!scrollRef) return;
        const el = scrollRef;
        if (!isNearBottom) {
          // The user is reading older content — refresh the sticky
          // overlay rather than dragging them back to the bottom.
          requestAnimationFrame(updateStickyPrompt);
          return;
        }
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      },
    ),
  );

  async function handleSubmit(text: string) {
    // Snapshot the attachments at submit time so a slow IPC followed
    // by a fast paste cannot bleed the next turn's images into this
    // one. Cleared as soon as the IPC accepts so the composer is
    // ready for the next turn.
    const attached = images.attachedImages();
    try {
      const requestId = await writeHeadlessInput(
        props.tab.id,
        text,
        attached.map(({ path, mediaType }) => ({ path, mediaType })),
      );
      store.appendUserMessage(
        props.tab.id,
        requestId,
        text,
        attached.map(({ path, name }) => ({ path, name })),
      );
      images.clearAll();
    } catch (error) {
      if (isTurnInFlightError(error)) {
        // The previous turn is still running — the optimistic status
        // bump in `appendUserMessage` should normally prevent the user
        // from reaching this branch, but a state-machine race (very
        // fast Enter / cancel) can still trigger it. Silently drop
        // the second send rather than scaring the user with a fake
        // error row; their next attempt after `Status::Idle` will
        // succeed.
        return;
      }
      // Permanent failure (image rejected, spawn died, etc). Drop
      // the attached images so a retry does not re-send the same
      // poisoned payload — the user can re-attach if the failure
      // was transient. The error row that follows tells them why.
      images.clearAll();
      // Surface the failure as an error status so the next render
      // shows the system row (`adaptHeadlessMessages` builds the
      // trailing system message from `errorMessage`).
      store.applyEvent({
        type: "status",
        tabId: props.tab.id,
        status: "error",
        errorKind: "other",
        message: describeIpcError(error),
      });
    }
  }

  /**
   * `SendError::Busy` reaches the frontend wrapped as
   * `{ PtyWriteFailed: "session already has a turn in flight" }`.
   * The Display string is the only stable signal — the AppError tag
   * itself is shared with other write failures, so we sniff the
   * message body. Anything that does not match is treated as a real
   * error worth surfacing to the user.
   */
  function isTurnInFlightError(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    if (!("PtyWriteFailed" in error)) return false;
    const detail = (error as Record<string, unknown>).PtyWriteFailed;
    return typeof detail === "string" && detail.includes("turn in flight");
  }

  /**
   * Tauri serialises Rust `AppError` as a tagged object like
   * `{ "PtyWriteFailed": "..." }`, which `String(err)` would render as
   * the useless `"[object Object]"`. Pull out the variant tag and
   * detail message so the user sees something actionable.
   */
  function describeIpcError(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (typeof error === "object" && error !== null) {
      const entries = Object.entries(error);
      if (entries.length === 1) {
        const [tag, value] = entries[0]!;
        return typeof value === "string" && value.length > 0
          ? `${tag}: ${value}`
          : tag;
      }
      try {
        return JSON.stringify(error);
      } catch {
        // fall through to String(error)
      }
    }
    return String(error);
  }

  function handleInterrupt() {
    void cancelHeadlessMessage(props.tab.id).catch((e) =>
      console.warn("[headless] interrupt cancel failed", e),
    );
  }

  // Slash commands: claude itself interprets `/help`, `/compact`, etc.
  // — we just forward the literal text. The slash menu UI in
  // ChatInput already filters and selects; we re-emit the chosen id
  // as `/<id>` so the command lands inside the model's context.
  function handleSlashCommand(id: string) {
    void handleSubmit(`/${id}`);
  }

  const appendInputHistory = (text: string) =>
    setInputHistory(appendToHistory(inputHistory(), text));

  return (
    <div class={chatStyles.container}>
      <Show when={images.isDragOver()}>
        <div class={chatStyles.dropOverlay}>
          <span>Drop files here</span>
        </div>
      </Show>
      <Show when={stickyPrompt()}>
        {(text) => (
          <div class={chatStyles.stickyOverlay}>
            <span class={chatStyles.stickyOverlayText}>{text()}</span>
          </div>
        )}
      </Show>
      <div ref={scrollRef} class={chatStyles.messages} onScroll={handleScroll}>
        <Show when={messages().length === 0}>
          <div class={chatStyles.welcome}>
            <div class={chatStyles.welcomeText}>
              {props.tab.cliConfig.cliType === "codex" ? "Codex" : "Claude Code"}
            </div>
            <div class={chatStyles.welcomeSub}>Headless · ready for input</div>
          </div>
        </Show>
        <Index each={messages()}>
          {(msg, index) => (
            <div
              ref={(el) => {
                if (el) messageEls.set(index, el);
                else messageEls.delete(index);
              }}
              data-msg-index={index}
            >
              <MessageBubble message={msg()} />
            </div>
          )}
        </Index>
      </div>
      <Show when={isStreaming()}>
        <BusySpinner />
      </Show>
      <ChatInput
        tabId={props.tab.id}
        cliType={props.tab.cliConfig.cliType}
        mode={props.tab.cliConfig.mode}
        workingDir={props.tab.cliConfig.workingDir}
        isStreaming={isStreaming()}
        attachedImages={images.attachedImages()}
        onRemoveImage={images.removeImage}
        onPaste={images.handlePaste}
        onSubmit={(t) => void handleSubmit(t)}
        onSlashCommand={handleSlashCommand}
        onInterrupt={handleInterrupt}
        inputHistory={inputHistory()}
        onAppendHistory={appendInputHistory}
        // Mode is fixed at spawn time — see `chat-input.tsx` prop doc.
        readOnlyMode
      />
    </div>
  );
}
