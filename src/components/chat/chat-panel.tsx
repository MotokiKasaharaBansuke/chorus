import { createSignal, createEffect, on, createMemo, For, Index, Show, onMount, onCleanup } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { streamEventDispatcher, ptyExitDispatcher } from "../../lib/event-dispatcher";
import { sendMessage as sendMessageCmd, killPty, interruptPty, spawnPty, getStreamSessionId, spawnEphemeralPty, listSessions, readSession, listCodexSessions, readCodexSession, gitHasTrackedChanges, type SessionInfo, type ImageAttachmentPayload } from "../../lib/commands";
import { useReviewRequest } from "../../hooks/use-review-request";
import { useSendReview } from "../../hooks/use-send-review";
import { getOrCreateParser } from "../../lib/stream-parser-registry";
import { MessageBubble } from "./message-bubble";
import { BusySpinner } from "./busy-spinner";
import { ModelPicker } from "./model-picker";
import { ChatInput } from "./chat-input";
import { SessionPicker } from "./session-picker";
import { ClawdIcon, CodexIcon } from "../icons";
import type { Tab, ChatMessage } from "../../types";
import { effectivePtyId, isTabStreaming } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useUsageStore } from "../../stores/usage-store";
import { classifyStreamError } from "../../lib/classify-error";
import { isValidTempImagePath } from "../../lib/validate-path";
import { submitWithBusyRetry } from "../../lib/submit-with-busy-retry";
import { WorktreeResetConfirm } from "../worktree/worktree-reset-confirm";
import { TerminalModal } from "../terminal/terminal-modal";
import { REPL_COMMANDS, matchReplCommand } from "../../lib/repl-commands";
import { DEFAULT_CONTEXT_WINDOW_SIZE, AUTO_COMPACT_RESET_THRESHOLD, contextColor, shouldAutoCompact, buildCompactCommand } from "../../lib/context-window";
import { appendToHistory } from "./input-history";
import { SlashCommandQueue } from "./slash-command-queue";
import { useThrottledUpdate } from "../../hooks/use-throttled-update";
import { useImageAttachment } from "../../hooks/use-image-attachment";
import { findStickyPromptText } from "../../lib/find-sticky-prompt-text";
import styles from "./chat-panel.module.css";


interface ChatPanelProps {
  tab: Tab;
  /** When false, the panel skips expensive DOM updates (setMessages, scroll,
   *  usage calculation) while still processing stream events so the parser
   *  stays current. On becoming active, the latest state is flushed to the UI
   *  in one pass. This avoids wasted work for hidden tabs in multi-tab groups. */
  isActive: boolean;
}

export function ChatPanel(props: ChatPanelProps) {
  const store = useTabStore();
  const settings = useSettingsStore();
  /** Effective PTY ID (differs from tab.id after PTY respawn) */
  const ptyId = () => effectivePtyId(props.tab);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(isTabStreaming(props.tab.status));
  const images = useImageAttachment({ tabId: props.tab.id });
  const [pastSessions, setPastSessions] = createSignal<SessionInfo[]>([]);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const usageStore = useUsageStore();
  const parser = getOrCreateParser(props.tab.id);
  const [contextInputTokens, setContextInputTokens] = createSignal(0);
  const [contextWindowSize, setContextWindowSize] = createSignal(
    parser.getContextWindow() ?? DEFAULT_CONTEXT_WINDOW_SIZE,
  );
  const contextPct = createMemo(() => contextInputTokens() / contextWindowSize());
  const contextIndicatorColor = createMemo(() => contextColor(contextPct()));
  const showContextIndicator = createMemo(() =>
    contextInputTokens() > 0 && props.tab.cliConfig.cliType === "claude-code"
  );
  const [inputHistory, setInputHistory] = createSignal<readonly string[]>([]);
  const appendInputHistory = (text: string) =>
    setInputHistory(appendToHistory(inputHistory(), text));
  const [stickyPrompt, setStickyPrompt] = createSignal<string | null>(null);
  let scrollRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const MESSAGE_ESTIMATED_HEIGHT = 80;

  // Virtual scroller — only renders messages visible in the viewport + a
  // small overscan buffer.  With 20 panes × 100+ messages each, this keeps
  // the DOM at ~200 nodes total instead of 2,000+.
  const virtualizer = createVirtualizer({
    get count() { return messages().length; },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => MESSAGE_ESTIMATED_HEIGHT,
    overscan: 5,
  });

  /** Scroll to the last message. Uses double-rAF so the scroll executes
   *  AFTER batchMeasure has updated item sizes in the first rAF — this
   *  eliminates layout shift caused by scrolling with estimateSize before
   *  actual measurements arrive. The outer rAF coalesces multiple calls
   *  per frame into a single scroll. */
  let scrollRafId: number | null = null;
  function scrollToBottom() {
    if (scrollRafId !== null) return;
    // Clear sticky overlay immediately — we're about to be at the bottom
    // where the overlay should never appear.
    setStickyPrompt(null);
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      requestAnimationFrame(() => {
        if (unmounted) return;
        const len = messages().length;
        if (len > 0) {
          virtualizer.scrollToIndex(len - 1, { align: "end" });
        }
      });
    });
  }

  // Batch virtualizer measurements: instead of scheduling one rAF per item,
  // collect refs and measure them all in a single rAF callback.
  let measureBatch: HTMLElement[] = [];
  let measureRafId: number | null = null;

  function batchMeasure(el: HTMLElement) {
    measureBatch.push(el);
    if (measureRafId !== null) return;
    measureRafId = requestAnimationFrame(() => {
      measureRafId = null;
      const batch = measureBatch;
      measureBatch = [];
      for (const e of batch) {
        if (e.isConnected) virtualizer.measureElement(e);
      }
    });
  }

  // Sticky prompt overlay: find the last user message scrolled past the top.
  let stickyRafId: number | null = null;
  function scheduleStickyUpdate() {
    if (stickyRafId !== null) return;
    stickyRafId = requestAnimationFrame(() => {
      stickyRafId = null;
      if (unmounted || !scrollRef) return;
      setStickyPrompt(findStickyPromptText(
        messages(),
        virtualizer.getVirtualItems(),
        scrollRef,
        MESSAGE_ESTIMATED_HEIGHT,
      ));
    });
  }

  onCleanup(() => {
    if (scrollRafId !== null) { cancelAnimationFrame(scrollRafId); scrollRafId = null; }
    if (stickyRafId !== null) { cancelAnimationFrame(stickyRafId); stickyRafId = null; }
    if (measureRafId !== null) { cancelAnimationFrame(measureRafId); measureRafId = null; }
    measureBatch = [];
  });

  let autoCompactTriggered = false;

  // Restore messages from a surviving parser (e.g. after layout-triggered remount)
  const existing = parser.getMessages();
  if (existing.length > 0) {
    setMessages(existing);
    scrollToBottom();
  }

  // When isActive transitions false→true, flush the latest parser state into
  // the UI in one pass. Uses a prev-value guard so it fires only on the
  // transition, not on every re-evaluation where isActive is already true.
  let prevIsActive = props.isActive;
  createEffect(() => {
    const now = props.isActive;
    if (now && !prevIsActive) {
      const latest = parser.getMessages();
      if (latest.length > 0) {
        setMessages(latest);
        scrollToBottom();
      }
    }
    prevIsActive = now;
  });

  function applyUpdate(msgs: ChatMessage[]) {
    setMessages(msgs);
    scrollToBottom();

    // O(1) — usage stats are accumulated incrementally inside StreamParser.
    const cliType = props.tab.cliConfig.cliType;
    const usage = parser.getUsageSnapshot();
    if (cliType === "claude-code" || cliType === "codex") {
      usageStore.updateTabUsage({
        tabId: props.tab.id, tabTitle: props.tab.title, cliType,
        costUsd: usage.costUsd, inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens, turnCount: usage.turnCount,
      });
    }

    if (cliType === "claude-code" && usage.lastContextTokens !== undefined) {
      setContextInputTokens(usage.lastContextTokens);
      const pct = contextPct();
      // Reset auto-compact latch when context drops below threshold OR
      // when compaction is detected (context tokens dropped >40%).
      if (pct < AUTO_COMPACT_RESET_THRESHOLD || usage.isCompacted) {
        autoCompactTriggered = false;
      } else if (shouldAutoCompact(pct, isStreaming(), autoCompactTriggered)) {
        autoCompactTriggered = true;
        const myGen = ++pendingAutoCompactGeneration;
        const cmd = buildCompactCommand(parser.getLastUserPrompt());
        queueMicrotask(() => {
          if (myGen !== pendingAutoCompactGeneration) return;
          sendAsSlashCommand(cmd, { silent: true });
        });
      }
    }
  }

  // Throttle parser → DOM updates to ~20fps. The parser's rAF already limits
  // to 60fps, but SolidJS reconciliation + virtualizer measurement at higher
  // rates starves the main thread with 20 panes streaming simultaneously.
  const throttle = useThrottledUpdate({
    onApply: applyUpdate,
    isActive: () => props.isActive,
    isDisposed: () => unmounted,
  });
  const unsubUpdate = parser.onUpdate(throttle.handleUpdate);
  onCleanup(unsubUpdate);
  const unsubRateLimit = parser.onRateLimit((info) => {
    usageStore.updateRateLimit(info);
  });
  onCleanup(unsubRateLimit);
  const unsubContextWindow = parser.onContextWindow((size) => {
    setContextWindowSize(size);
  });
  onCleanup(unsubContextWindow);

  // Status transitions delegated to StreamParser (avoids re-parsing the same JSON line)
  const unsubStatus = parser.onStatusChange((status) => {
    setIsStreaming(status === "streaming");
    store.updateStatus(props.tab.id, status === "streaming" ? "running" : "waiting");
    if (status === "idle") drainPendingSlashCommand();
  });
  onCleanup(unsubStatus);

  // Safety net: sync isStreaming if store status is externally cleared (e.g. final PTY event lost during remount)
  createEffect(() => {
    if (!isTabStreaming(props.tab.status) && isStreaming()) {
      setIsStreaming(false);
    }
  });

  // Reactive subscriptions — re-subscribe automatically when ptyId changes (e.g. after respawn)
  createEffect(() => {
    const id = ptyId();
    // Reset guards on respawn so the new session starts clean
    autoCompactTriggered = false;
    slashQueue.clear();
    pendingDrainGeneration += 1;
    pendingAutoCompactGeneration += 1;
    throttle.reset();
    // Eagerly capture session ID so session.json can restore the conversation
    // even if the user never sends a message before closing the app.
    captureSessionIdIfNeeded(id);
    const unsub = streamEventDispatcher.subscribe(id, (payload) => {
      parser.processLine(payload.data);
    });
    onCleanup(unsub);
  });

  createEffect(() => {
    const id = ptyId();
    const unsub = ptyExitDispatcher.subscribe(id, (payload) => {
      store.updateStatus(props.tab.id, payload.code === 0 ? "completed" : "error");
    });
    onCleanup(unsub);
  });

  onMount(async () => {
    // Load past sessions
    try {
      if (props.tab.cliConfig.cliType === "claude-code") {
        setPastSessions(await listSessions(props.tab.cliConfig.workingDir));
      } else if (props.tab.cliConfig.cliType === "codex") {
        setPastSessions(await listCodexSessions(props.tab.cliConfig.workingDir));
      }
    } catch { /* ignore */ }

    // Auto-restore last session content on mount (e.g. after app restart).
    // Try lastSessionId first, then fall back to the most recent session.
    const candidates = [
      props.tab.lastSessionId,
      pastSessions().length > 0 ? pastSessions()[0].sessionId : undefined,
    ].filter((id): id is string => !!id);

    for (const id of candidates) {
      try {
        const lines = await fetchSessionLines(props.tab, id);
        if (lines.length > 0) {
          parser.loadSession(lines);
          store.updateLastSessionId(props.tab.id, id);
          break;
        }
      } catch { /* session file may not exist — try next candidate */ }
    }
  });

  // Listen for refresh events dispatched from App.tsx to clear parser state
  function handleRefreshEvent(e: Event) {
    if (!(e instanceof CustomEvent)) return;
    if (e.detail?.tabId !== props.tab.id) return;
    parser.loadSession([]);
    setIsStreaming(false);
  }
  window.addEventListener("mlm-refresh-tab", handleRefreshEvent);
  onCleanup(() => window.removeEventListener("mlm-refresh-tab", handleRefreshEvent));


  // Throttle PTY respawns: at most once per 5 seconds
  let lastRespawnAt = 0;

  // Cancellation signals for in-flight submit-with-retry loops. Set on
  // component unmount (tab closed) or when the user interrupts, so the retry
  // helper and respawn path exit without touching a disposed store or
  // reviving a killed PTY.
  let unmounted = false;
  let interrupted = false;
  const isCancelled = () => unmounted || interrupted;
  onCleanup(() => { unmounted = true; });

  // Queues a single slash command sent while a turn is streaming so the request
  // doesn't silently drop (auto-compact firing during a still-streaming turn,
  // or a manual donut click landing between status flips). Drained when the
  // parser reports "idle"; replaced by later requests so a stale auto-compact
  // can't override an explicit user click.
  const slashQueue = new SlashCommandQueue();
  // Generation counters that invalidate any in-flight microtask when the
  // conversation state changes (interrupt, PTY respawn). Two counters so the
  // drain path and the auto-compact path can each be cancelled without
  // invalidating each other when both fire in the same tick.
  let pendingDrainGeneration = 0;
  let pendingAutoCompactGeneration = 0;

  type SendResult = "sent" | "busy" | "error";

  /** Save the CLI's session UUID so session.json can restore the conversation.
   *  Captures targetPtyId at call time to guard against ptyId changing before
   *  the async IPC resolves (e.g. a second respawn). */
  function captureSessionIdIfNeeded(targetPtyId: string) {
    if (props.tab.lastSessionId) return;
    const tabId = props.tab.id;
    getStreamSessionId(targetPtyId)
      .then(sessionId => {
        if (ptyId() === targetPtyId) store.updateLastSessionId(tabId, sessionId);
      })
      .catch(() => {});
  }

  /** Send a message to the PTY, respawning it once if the session is gone.
   *  Spinner lifecycle is managed by the caller (submitMessage) — this
   *  function only reports the outcome. */
  async function sendWithRespawn(message: string, images?: ReadonlyArray<ImageAttachmentPayload>): Promise<SendResult> {
    try {
      await sendMessageCmd(ptyId(), message, images);
      if (isCancelled()) return "error";
      store.updateStatus(props.tab.id, "running");
      captureSessionIdIfNeeded(ptyId());
      return "sent";
    } catch (error: unknown) {
      const kind = classifyStreamError(error);

      if (kind === "busy") {
        store.updateStatus(props.tab.id, "running");
        return "busy";
      }

      if (kind !== "not_found") {
        store.updateStatus(props.tab.id, "error");
        parser.addUserMessage("[Error: Failed to send message.]");
        return "error";
      }

      const now = Date.now();
      if (now - lastRespawnAt < 5_000) {
        store.updateStatus(props.tab.id, "error");
        parser.addUserMessage("[Error: PTY respawn failed. Please restart the tab.]");
        return "error";
      }
      try {
        lastRespawnAt = now;
        await killPty(ptyId()).catch(() => {});
        if (isCancelled()) return "error";
        const newId = await spawnPty(props.tab.cliConfig);
        if (isCancelled() || !store.getTab(props.tab.id)) {
          await killPty(newId).catch(() => {});
          return "error";
        }
        store.updatePtyId(props.tab.id, newId);
        await sendMessageCmd(newId, message, images);
        if (isCancelled()) return "error";
        store.updateStatus(props.tab.id, "running");
        captureSessionIdIfNeeded(newId);
        return "sent";
      } catch (retryError: unknown) {
        store.updateStatus(props.tab.id, "error");
        const errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
        parser.addUserMessage(`[Error: Failed to send message. ${errorMessage}]`);
        return "error";
      }
    }
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms));

  async function submitMessage(
    message: string,
    images?: ReadonlyArray<ImageAttachmentPayload>,
  ): Promise<void> {
    interrupted = false;
    const outcome = await submitWithBusyRetry({
      send: () => sendWithRespawn(message, images),
      forceReset: async () => { await killPty(ptyId()).catch(() => {}); },
      sleep,
      isCancelled,
      onForceReset: () =>
        parser.addUserMessage("[Session unresponsive; resetting and retrying...]"),
      onResetFailed: () =>
        parser.addUserMessage("[Error: Session reset failed. Please restart the tab.]"),
    });
    if (unmounted) return;
    if (outcome !== "sent") setIsStreaming(false);
  }

  async function handleSubmitFromInput(text: string) {
    if (isStreaming()) return;
    // Intercept REPL-only commands (e.g. /login) before sending to stream session
    const replId = matchReplCommand(text);
    if (replId) {
      await handleReplCommand(replId);
      return;
    }
    const attached = images.attachedImages();
    const imagePayloads = attached
      .filter(img => isValidTempImagePath(img.path) && img.mediaType)
      .map(img => ({ path: img.path, mediaType: img.mediaType }));

    parser.addUserMessage(text, attached);
    images.clearAll();
    setIsStreaming(true);

    await submitMessage(text, imagePayloads.length > 0 ? imagePayloads : undefined);
    // Temp files are cleaned up by the Rust reader thread after the CLI process
    // exits, not here — the CLI may still be reading them when this returns.
  }

  const [resetConfirm, setResetConfirm] = createSignal<{ isDirty: boolean } | null>(null);
  const [replTerminal, setReplTerminal] = createSignal<{ title: string; ptyId: string } | null>(null);
  let replInProgress = false;

  async function handleReplCommand(id: string): Promise<boolean> {
    const def = REPL_COMMANDS[id];
    if (!def || replInProgress) return false;
    replInProgress = true;
    try {
      // Kill any existing ephemeral PTY before opening a new one
      const existing = replTerminal();
      if (existing) {
        await killPty(existing.ptyId).catch(() => {});
        setReplTerminal(null);
      }
      const newPtyId = await spawnEphemeralPty(
        def.command,
        [...def.args],
        props.tab.cliConfig.workingDir,
      );
      setReplTerminal({ title: def.title, ptyId: newPtyId });
      return true;
    } catch {
      parser.addUserMessage(`[Error: Failed to run /${id}]`);
      return false;
    } finally {
      replInProgress = false;
    }
  }

  const UI_COMMANDS: Record<string, () => void> = {
    "clear-conversation": () => {
      if (isStreaming()) return;
      if (!props.tab.worktree) {
        parser.loadSession([]);
        return;
      }
      gitHasTrackedChanges(props.tab.worktree.path)
        .catch((): boolean => true)
        .then((isDirty) => setResetConfirm({ isDirty }));
    },
    "attach-file": () => images.openFilePicker(),
    "resume-conversation": () => {
      virtualizer.scrollToIndex(0);
      if (messages().length > 0) { setMessages([]); parser.loadSession([]); }
    },
    "model": () => setShowModelPicker(true),
  };

  async function selectSlashCommand(id: string) {
    const handler = UI_COMMANDS[id];
    if (handler) { handler(); return; }
    if (await handleReplCommand(id)) return;
    sendAsSlashCommand(id);
  }

  /** Send a slash command to the CLI. Queues if a turn is still streaming
   *  so the request runs as soon as it ends, instead of being silently dropped.
   *  `silent` suppresses the visible user message — used for auto-compact so
   *  the chat history doesn't fill with synthetic /compact entries. */
  async function sendAsSlashCommand(id: string, options?: { silent?: boolean }) {
    const silent = options?.silent ?? false;
    if (isStreaming()) {
      slashQueue.enqueue({ id, silent });
      return;
    }
    const command = `/${id}`;
    if (!silent) parser.addUserMessage(command);
    setIsStreaming(true);
    await submitMessage(command);
  }

  function drainPendingSlashCommand() {
    const cmd = slashQueue.drain();
    if (!cmd) return;
    const myGen = ++pendingDrainGeneration;
    queueMicrotask(() => {
      if (myGen !== pendingDrainGeneration) return;
      sendAsSlashCommand(cmd.id, { silent: cmd.silent });
    });
  }


  // --- Session reading (shared between picker and auto-restore) ---
  async function fetchSessionLines(tab: typeof props.tab, sessionId: string): Promise<string[]> {
    return tab.cliConfig.cliType === "codex"
      ? readCodexSession(sessionId)
      : readSession(tab.cliConfig.workingDir, sessionId);
  }

  async function loadSessionFromPicker(session: SessionInfo) {
    try {
      parser.loadSession(await fetchSessionLines(props.tab, session.sessionId));
      store.updateLastSessionId(props.tab.id, session.sessionId);
      setShowSessionPicker(false);
    } catch {
      store.updateStatus(props.tab.id, "error");
    }
  }

  function handleModelSelect(modelId: string) {
    store.updateModel(props.tab.id, modelId || undefined);
    // Also notify the CLI about model change
    sendAsSlashCommand(`model ${modelId || "default"}`);
  }


  async function handleInterrupt() {
    // Flip user-visible state synchronously, before awaiting the IPC.
    // The send button reads `isStreaming` to disable itself; if we waited
    // for `interruptPty` to round-trip first, a fast Enter press could
    // sneak through and queue a `sendMessage` against the child we're
    // about to kill.
    interrupted = true;
    setIsStreaming(false);
    store.updateStatus(props.tab.id, "waiting");
    // Drop any queued slash command and re-arm auto-compact so the next high-pct
    // turn can re-fire — otherwise the user is stuck with a triggered flag and
    // a pending compact that the interrupt invalidated.
    slashQueue.clear();
    autoCompactTriggered = false;
    pendingDrainGeneration += 1;
    pendingAutoCompactGeneration += 1;
    // Interrupt — not kill — so the StreamSession (and its CLI session_id)
    // survives. The next send_message resumes the same conversation via
    // `--resume`, preserving model context.
    try {
      await interruptPty(ptyId());
    } catch { /* session missing or already idle */ }
    parser.addInterrupted();
  }

  const sendReview = useSendReview({
    tab: props.tab,
    messages,
    addMessage: (t) => parser.addUserMessage(t),
  });

  // Review hook is always initialized; requestReview no-ops for non-CLI tabs
  // since git_changed_files will return an error for non-existent working dirs.
  const review = useReviewRequest({
    tab: props.tab,
    reviewCliType: () => settings.reviewCliType,
    addMessage: (t) => parser.addUserMessage(t),
  });

  function handleClearOnly() {
    parser.loadSession([]);
    setResetConfirm(null);
  }

  function handleResetWorktree() {
    parser.loadSession([]);
    setResetConfirm(null);
    setIsStreaming(false);
    window.dispatchEvent(new CustomEvent("mlm-worktree-reset", { detail: { tabId: props.tab.id } }));
  }

  return (
    <div class={styles.container} ref={containerRef} data-tab-id={props.tab.id}>
      <Show when={replTerminal()}>
        {(term) => (
          <TerminalModal
            title={term().title}
            ptyId={term().ptyId}
            onClose={() => setReplTerminal(null)}
          />
        )}
      </Show>
      <WorktreeResetConfirm
        worktree={resetConfirm() ? (props.tab.worktree ?? null) : null}
        isDirty={resetConfirm()?.isDirty ?? false}
        onClearOnly={handleClearOnly}
        onReset={handleResetWorktree}
        onCancel={() => setResetConfirm(null)}
      />
      <Show when={showSessionPicker()}>
        <SessionPicker
          sessions={pastSessions()}
          onSelect={loadSessionFromPicker}
          onClose={() => setShowSessionPicker(false)}
        />
      </Show>
      <Show when={showModelPicker()}>
        <ModelPicker
          cliType={props.tab.cliConfig.cliType}
          currentModel={props.tab.cliConfig.model}
          containerEl={containerRef}
          onSelect={handleModelSelect}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>
      <Show when={images.isDragOver()}>
        <div class={styles.dropOverlay}>
          <span>Drop files here</span>
        </div>
      </Show>
      <Show when={pastSessions().length > 0}>
        <button
          class={styles.sessionPickerBtn}
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
          <div class={styles.stickyOverlay}>
            <span class={styles.stickyOverlayText}>{text()}</span>
          </div>
        )}
      </Show>
      <div ref={scrollRef} class={styles.messages} onScroll={scheduleStickyUpdate} onClick={(e) => {
        const link = (e.target as HTMLElement).closest("a[data-external-link]") as HTMLAnchorElement | null;
        if (link) {
          e.preventDefault();
          const url = link.getAttribute("href");
          if (url && url !== "#") {
            import("@tauri-apps/plugin-opener").then(m => m.openUrl(url)).catch(() => {});
          }
        }
      }}>
        <Show when={messages().length === 0}>
          <div class={styles.welcome}>
            <div class={styles.welcomeIcon}>
              {props.tab.cliConfig.cliType === "codex"
                ? <CodexIcon size={48} />
                : <ClawdIcon size={48} />
              }
            </div>
            <div class={styles.welcomeText}>
              {props.tab.cliConfig.cliType === "codex" ? "Codex" : "Claude Code"}
            </div>
            <div class={styles.welcomeSub}>
              {props.tab.cliConfig.mode === "dangerously-skip-permissions"
                ? "Dangerous mode — bypass on"
                : "Ready for input"}
            </div>
            <Show when={pastSessions().length > 0}>
              <div class={styles.pastSessions}>
                <div class={styles.pastSessionsTitle}>Past Conversations</div>
                <For each={pastSessions().slice(0, 8)}>
                  {(session) => (
                    <div class={styles.pastSessionItem} onClick={() => loadSessionFromPicker(session)}>
                      <span class={styles.pastSessionText}>
                        {session.firstLine || session.sessionId.slice(0, 8)}
                      </span>
                      <span class={styles.pastSessionDate}>
                        {new Date(session.lastModified * 1000).toLocaleDateString()}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        {/* Virtualized message list — only renders messages in the viewport
            + overscan buffer.  Absolute positioning + transform avoids layout
            recalculations when items above the viewport change height. */}
        <Show when={messages().length > 0}>
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
            {/* <Index> reuses DOM nodes instead of recreating them on every
                virtualizer recalculation. With <For>, every recalc destroyed
                all elements — breaking ResizeObserver observation and leaving
                a one-frame gap where items used stale estimated heights.
                During streaming, this accumulated into persistent text overlap. */}
            <Index each={virtualizer.getVirtualItems()}>
              {(vItem) => {
                const msg = () => messages()[vItem().index];
                let elRef: HTMLElement | undefined;

                // Re-measure when:
                //  - a different message occupies this slot (scroll / insertion)
                //  - the message object changes (streaming adds blocks, result
                //    event updates metadata)
                // Without msg(), the virtualizer uses stale cached heights and
                // items below the changed message overlap during streaming.
                // defer: true skips the initial run — the ref callback handles
                // first measurement.
                createEffect(on(
                  () => [vItem().index, msg()] as const,
                  () => { if (elRef) batchMeasure(elRef); },
                  { defer: true },
                ));

                return (
                  <Show when={msg()}>
                    {(m) => (
                      <div
                        ref={(el) => {
                          elRef = el;
                          batchMeasure(el);
                        }}
                        data-index={vItem().index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem().start}px)`,
                        }}
                      >
                        <MessageBubble message={m()} />
                      </div>
                    )}
                  </Show>
                );
              }}
            </Index>
          </div>
        </Show>
      </div>
      <Show when={isStreaming()}>
        <BusySpinner />
      </Show>
      <Show when={sendReview.hasSourceTab() && !isStreaming() && messages().length > 0}>
        <button
          class={styles.sendToSourceBtn}
          onClick={sendReview.sendToSource}
          disabled={sendReview.isSending()}
          title="Send review result to source tab"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M14 8H2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M6 4L2 8l4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {sendReview.isSending() ? "Sending..." : "Send review to source"}
        </button>
      </Show>
      <ChatInput
        tabId={props.tab.id}
        cliType={props.tab.cliConfig.cliType}
        mode={props.tab.cliConfig.mode}
        workingDir={props.tab.cliConfig.workingDir}
        isStreaming={isStreaming()}
        attachedImages={images.attachedImages()}
        onRemoveImage={images.removeImage}
        onSubmit={handleSubmitFromInput}
        onSlashCommand={selectSlashCommand}
        onPaste={images.handlePaste}
        onInterrupt={handleInterrupt}
        onRequestReview={review.requestReview}
        isReviewInProgress={review.isReviewInProgress()}
        inputHistory={inputHistory()}
        onAppendHistory={appendInputHistory}
        contextIndicator={
          showContextIndicator()
            ? {
                pct: contextPct(),
                color: contextIndicatorColor(),
                onCompact: () => sendAsSlashCommand(buildCompactCommand(parser.getLastUserPrompt())),
              }
            : undefined
        }
      />
    </div>
  );
}
