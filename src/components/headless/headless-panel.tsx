/**
 * One headless agent pane. Visually identical to the PTY chat panel:
 * the same `<MessageBubble>` (timeline rows, dot states, tool cards,
 * Edit diffs, TodoWrite checklists) and the same `<ChatInput>`
 * (mode badge, slash menu, input history, ⌘+Enter, Esc-to-cancel).
 *
 * What headless deliberately drops compared to the PTY panel:
 * - image attachment / paste (claude headless input is text-only)
 * - REPL terminal modal, worktree reset confirm
 *   (those rely on PTY-side artifacts that headless does not produce)
 * - virtualizer (`@tanstack/solid-virtual`) — kept simple here so the
 *   first parity pass ships small; can be ported in a follow-up if a
 *   long headless session shows scroll-perf issues
 *
 * What headless adds beyond the PTY panel:
 * - session picker (`SessionPicker` from chat/) reuses the same JSONL
 *   files claude/codex write under `~/.claude/projects/...` and
 *   `~/.codex/sessions/...`; selecting a row hydrates the message
 *   list via `parseSessionJsonl` and re-spawns the backend with
 *   `resumeSessionAt` so the next turn lands in the historical thread.
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
import { SessionPicker } from "../chat/session-picker";
import { useImageAttachment } from "../../hooks/use-image-attachment";
import {
  listSessions,
  listCodexSessions,
  readSession,
  readCodexSession,
  type SessionInfo,
} from "../../lib/commands";
import {
  cancelHeadlessMessage,
  classifyHeadlessError,
  killHeadless,
  spawnHeadless,
  writeHeadlessInput,
} from "../../lib/headless/commands";
import { subscribeToHeadlessTab } from "../../lib/headless/event-channel";
import { findStickyPromptText } from "../../lib/find-sticky-prompt-text";
import { STREAM_STALL_MS, STALL_CHECK_INTERVAL_MS, STALL_INTERRUPTED_MESSAGE } from "../../lib/stall-constants";
import { useHeadlessStore } from "../../stores/headless-store";
import type { Tab } from "../../types";

import { adaptHeadlessMessages } from "./adapt-messages";
import { parseSessionJsonl } from "./jsonl-to-headless";

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

  // Hoisted out of `createEffect` so `loadSessionFromPicker` can pause
  // and resume the subscription around `killHeadless` — without that
  // gap, events still in flight from the dying CLI process would
  // `applyEvent` onto the just-hydrated thread.
  let unsubscribeFromTab: (() => void) | undefined;

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
        let cancelled = false;
        void subscribeToHeadlessTab(tabId).then(async (off) => {
          if (cancelled) {
            off();
            return;
          }
          unsubscribeFromTab = off;
          await ensureBackendSession(tabId);
        });
        // Past sessions live in `~/.claude/projects/...` /
        // `~/.codex/sessions/...` and are populated by both PTY and
        // headless turns of the same CLI in the same cwd. Loading them
        // here (rather than in `onMount`) means a tab swap re-fetches
        // for the new working directory.
        void loadPastSessions();
        onCleanup(() => {
          cancelled = true;
          unsubscribeFromTab?.();
          unsubscribeFromTab = undefined;
        });
      },
    ),
  );

  /**
   * Spawn the backend session if it does not already exist. Safe to
   * call after every mount: a `session_busy` error means another
   * owner already has the session alive (the normal case during a
   * session's lifetime) and we treat it as success.
   */
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

  /**
   * Populate the session-picker list. A missing project directory is
   * the common case (no past sessions yet) so we keep the button
   * hidden, but we still log so a misconfigured `~/.claude/projects/`
   * (e.g. permission errors) shows up in dev tools rather than
   * vanishing silently.
   */
  async function loadPastSessions(): Promise<void> {
    const cliType = props.tab.cliConfig.cliType;
    try {
      if (cliType === "claude-code") {
        setPastSessions(await listSessions(props.tab.cliConfig.workingDir));
      } else if (cliType === "codex") {
        setPastSessions(await listCodexSessions(props.tab.cliConfig.workingDir));
      }
    } catch (error) {
      console.warn("[headless] loadPastSessions failed", error);
    }
  }

  /**
   * Re-entrancy guard. `loadSessionFromPicker` runs IPC reads + a
   * possibly multi-second JSONL parse; without a guard, a fast
   * double-click on the picker (or two rows in quick succession)
   * interleaves two orchestrations and the panel can end up with
   * thread A's UI and thread B's resume id. Set on entry, reset in
   * `finally`.
   */
  const [isResumingSession, setIsResumingSession] = createSignal(false);

  /**
   * Hydrate the panel from a chosen JSONL file and rebuild the
   * backend session against the recovered upstream id so the next
   * turn `--resume`s the historical thread.
   *
   * The orchestration order is load-bearing for correctness:
   *
   *   1. `pauseLiveChannel` — events still in flight from the
   *      about-to-be-killed CLI process must NOT be `applyEvent`-ed
   *      onto the freshly-loaded thread (they would tail-append a
   *      stranger's tokens to the loaded conversation).
   *   2. `killOrAbort` — graceful close → SIGTERM → SIGKILL. If this
   *      fails we abort: `spawnHeadless` would return
   *      `StreamSessionBusy` (silenced as success) and the next user
   *      turn would silently land in the OLD thread. The helper
   *      surfaces an error row and restores the live channel so the
   *      original session keeps streaming.
   *   3. `hydrateFromPickedSession` — read JSONL → parse → store. On
   *      a transient failure (read error, codex thread_id missing) it
   *      restores the channel against a fresh spawn so the panel
   *      stays usable, and returns false so we abort steps 4+5.
   *   4 + 5. `restoreLiveChannel` — resubscribe BEFORE respawning so
   *      the listener is in place for the new session's first
   *      `Status::Idle`, then `ensureBackendSession` re-spawns with
   *      the resume id picked up from the hydrated session.
   *
   * `isResumingSession` is held high across the whole sequence so the
   * `<ChatInput>` stays disabled — without it, a user typing fast in
   * the gap could submit a turn that lands in the wrong session or
   * gets dropped because the listener is not yet wired.
   */
  async function loadSessionFromPicker(picked: SessionInfo): Promise<void> {
    if (isResumingSession()) return;
    const tabId = props.tab.id;
    const cliType = props.tab.cliConfig.cliType;
    if (cliType !== "claude-code" && cliType !== "codex") return;

    setIsResumingSession(true);
    setShowSessionPicker(false);
    try {
      pauseLiveChannel();
      if (!(await killOrAbort(tabId))) return;
      if (!(await hydrateFromPickedSession(tabId, cliType, picked))) return;
      await restoreLiveChannel(tabId);
    } finally {
      setIsResumingSession(false);
    }
  }

  /** Step 1: stop dispatching events from the dying session. */
  function pauseLiveChannel(): void {
    unsubscribeFromTab?.();
    unsubscribeFromTab = undefined;
  }

  /**
   * Step 2: tear down the live session before hydration. Returns
   * `false` when the kill failed — the OLD session is still alive,
   * so we resubscribe to it (without spawning a duplicate) and let
   * the user retry rather than silently divert their next turn into
   * the wrong thread.
   */
  async function killOrAbort(tabId: string): Promise<boolean> {
    try {
      await killHeadless(tabId);
      return true;
    } catch (error) {
      emitErrorStatus(
        tabId,
        `Could not switch to past session: ${describeIpcError(error)}`,
      );
      unsubscribeFromTab = await subscribeToHeadlessTab(tabId);
      return false;
    }
  }

  /**
   * Step 3: load the JSONL, parse it, and stamp the store. Returns
   * `false` for two failures, both of which leave the backend dead
   * (kill already succeeded): an IPC read error, or a codex session
   * with no recoverable `thread_id` (would silently start a new
   * thread). Both restore a fresh live session before returning so
   * the panel stays usable.
   */
  async function hydrateFromPickedSession(
    tabId: string,
    cliType: "claude-code" | "codex",
    picked: SessionInfo,
  ): Promise<boolean> {
    let lines: string[];
    try {
      lines = cliType === "codex"
        ? await readCodexSession(picked.sessionId)
        : await readSession(props.tab.cliConfig.workingDir, picked.sessionId);
    } catch (error) {
      emitErrorStatus(tabId, describeIpcError(error));
      await restoreLiveChannel(tabId);
      return false;
    }

    const parsed = parseSessionJsonl(cliType, lines);
    // For claude the picker row id IS the upstream session id (it's
    // the JSONL filename — a UUID). For codex the row id is a file
    // path that `validate_session_id` would reject, so we lean on
    // the `thread_id` extracted from the JSONL itself.
    const resumeId = cliType === "claude-code"
      ? picked.sessionId
      : parsed.upstreamSessionId;

    if (cliType === "codex" && !resumeId) {
      emitErrorStatus(
        tabId,
        "Could not recover the codex thread id from the picked session — the conversation cannot be resumed.",
      );
      await restoreLiveChannel(tabId);
      return false;
    }

    store.hydrateMessages(tabId, parsed.messages, resumeId);
    return true;
  }

  /**
   * Steps 4 + 5: own the channel before the respawn so the new
   * session's very first event fires onto a live listener; then
   * issue `spawnHeadless` with the resume id picked up from the
   * hydrated session. Also reused as the recovery path inside
   * `hydrateFromPickedSession` when an abort needs a fresh session.
   */
  async function restoreLiveChannel(tabId: string): Promise<void> {
    unsubscribeFromTab = await subscribeToHeadlessTab(tabId);
    await ensureBackendSession(tabId);
  }

  /** Surface a recoverable failure as a trailing system row via the
   *  same `applyEvent` path the live stream uses. */
  function emitErrorStatus(tabId: string, message: string): void {
    store.applyEvent({
      type: "status",
      tabId,
      status: "error",
      errorKind: "other",
      message,
    });
  }

  const session = () => store.sessionFor(props.tab.id);
  const messages = createMemo(() => adaptHeadlessMessages(session()));

  const isStreaming = createMemo(() => {
    const status = session()?.status;
    return status === "thinking" || status === "running";
  });

  const [inputHistory, setInputHistory] = createSignal<readonly string[]>([]);

  // Past JSONL sessions for this tab's working directory. Loaded once
  // per tab in the subscribe effect above; the empty default keeps
  // the picker button hidden when no history (or a non-resumable cli
  // type) is available.
  const [pastSessions, setPastSessions] = createSignal<SessionInfo[]>([]);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);

  // Sticky overlay text — the last user message whose top edge has
  // scrolled above the viewport. Mirrors the chat-panel UX so reading
  // long assistant responses keeps the prompt that triggered them
  // visible at the top of the messages container.
  const [stickyPrompt, setStickyPrompt] = createSignal<string | null>(null);

  /**
   * DOM elements for each rendered message, keyed by index. Used by
   * `updateStickyPrompt` to read `offsetTop` without a virtualizer.
   * `Map` is rebuilt on every render slot via the ref callbacks
   * below; entries are removed when the slot is torn down.
   */
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
      <Show when={showSessionPicker()}>
        <SessionPicker
          sessions={pastSessions()}
          onSelect={(s) => void loadSessionFromPicker(s)}
          onClose={() => setShowSessionPicker(false)}
        />
      </Show>
      <Show when={pastSessions().length > 0}>
        <button
          class={chatStyles.sessionPickerBtn}
          onClick={() => setShowSessionPicker(true)}
          title="Past Conversations"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
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
        // Treat the resume orchestration as "streaming" from the
        // input's perspective: the kill→hydrate→respawn window must
        // not accept new turns, otherwise a fast Enter could race
        // the listener wiring or land in the wrong upstream session.
        isStreaming={isStreaming() || isResumingSession()}
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
