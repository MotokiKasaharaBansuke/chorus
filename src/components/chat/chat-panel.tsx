import { createSignal, createEffect, createMemo, For, Show, onMount, onCleanup } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { streamEventDispatcher, ptyExitDispatcher } from "../../lib/event-dispatcher";
import { sendMessage as sendMessageCmd, killPty, interruptPty, spawnPty, spawnEphemeralPty, saveTempImage, importImageFile, deleteTempImage, listSessions, readSession, listCodexSessions, readCodexSession, gitHasTrackedChanges, type SessionInfo, type ImageAttachmentPayload } from "../../lib/commands";
import { useReviewRequest } from "../../hooks/use-review-request";
import { useSendReview } from "../../hooks/use-send-review";
import { getOrCreateParser } from "../../lib/stream-parser-registry";
import { MessageBubble } from "./message-bubble";
import { BusySpinner } from "./busy-spinner";
import { ModelPicker } from "./model-picker";
import { ChatInput } from "./chat-input";
import { SessionPicker } from "./session-picker";
import { ClawdIcon, CodexIcon } from "../icons";
import type { Tab, ChatMessage, AttachedImage } from "../../types";
import { effectivePtyId, isTabStreaming } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import { useSettingsStore } from "../../stores/settings-store";
import { useUsageStore } from "../../stores/usage-store";
import { classifyStreamError } from "../../lib/classify-error";
import { isValidTempImagePath } from "../../lib/validate-path";
import { findStickyUserMessage } from "../../lib/find-sticky-user-message";
import { StickyPromptHeader } from "./sticky-prompt-header";
import { submitWithBusyRetry } from "../../lib/submit-with-busy-retry";
import { WorktreeResetConfirm } from "../worktree/worktree-reset-confirm";
import { TerminalModal } from "../terminal/terminal-modal";
import { REPL_COMMANDS, matchReplCommand } from "../../lib/repl-commands";
import { DEFAULT_CONTEXT_WINDOW_SIZE, AUTO_COMPACT_RESET_THRESHOLD, contextColor, shouldAutoCompact, COMPACT_COMMAND } from "../../lib/context-window";
import { appendToHistory } from "./input-history";
import { SlashCommandQueue } from "./slash-command-queue";
import { useThrottledUpdate } from "../../hooks/use-throttled-update";
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
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([]);
  const [isDragOver, setIsDragOver] = createSignal(false);
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
  const [stickyMessage, setStickyMessage] = createSignal<ChatMessage | null>(null);
  let scrollRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const MESSAGE_ESTIMATE_SIZE = 80;

  // Virtual scroller — only renders messages visible in the viewport + a
  // small overscan buffer.  With 20 panes × 100+ messages each, this keeps
  // the DOM at ~200 nodes total instead of 2,000+.
  const virtualizer = createVirtualizer({
    get count() { return messages().length; },
    getScrollElement: () => scrollRef ?? null,
    estimateSize: () => MESSAGE_ESTIMATE_SIZE,
    overscan: 5,
  });

  /** Scroll to the last message. Uses queueMicrotask instead of rAF so the
   *  scroll executes in the same frame as the SolidJS DOM update — avoids
   *  the 1-frame positional glitch caused by nested rAFs (notifyBatched →
   *  onUpdate → scrollToBottom). The length is re-read inside the microtask
   *  to avoid stale captures when setMessages fires between scheduling and
   *  execution. */
  function scrollToBottom() {
    queueMicrotask(() => {
      const len = messages().length;
      if (len > 0) {
        virtualizer.scrollToIndex(len - 1, { align: "end" });
      }
    });
  }

  // Sticky section header: throttled via rAF to avoid per-scroll-event work.
  let stickyRafId: number | null = null;

  function scheduleStickyUpdate() {
    if (stickyRafId !== null) return;
    stickyRafId = requestAnimationFrame(() => {
      stickyRafId = null;
      if (unmounted || !scrollRef) return;
      const result = findStickyUserMessage(
        messages(),
        virtualizer.getVirtualItems(),
        scrollRef.scrollTop,
        MESSAGE_ESTIMATE_SIZE,
      );
      setStickyMessage(result);
    });
  }

  onCleanup(() => {
    if (stickyRafId !== null) { cancelAnimationFrame(stickyRafId); stickyRafId = null; }
  });

  // On macOS, pasting a file triggers BOTH a Tauri drop event AND a DOM paste event.
  // The Tauri drop event fires FIRST, so we record when a drop was handled,
  // then suppress the subsequent DOM paste if it arrives within the dedup window.
  const DROP_DEDUP_WINDOW_MS = 500;
  let dropHandledAt = 0;
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
    scheduleStickyUpdate();

    const cliType = props.tab.cliConfig.cliType;
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let turnCount = 0;
    let lastContextTokens: number | undefined;
    for (const m of msgs) {
      if (m.role !== "assistant") continue;
      turnCount++;
      costUsd += m.costUsd ?? 0;
      inputTokens += m.inputTokens ?? 0;
      outputTokens += m.outputTokens ?? 0;
      if (m.inputTokens !== undefined) lastContextTokens = m.inputTokens;
    }
    if (cliType === "claude-code" || cliType === "codex") {
      usageStore.updateTabUsage({ tabId: props.tab.id, tabTitle: props.tab.title, cliType, costUsd, inputTokens, outputTokens, turnCount });
    }

    if (cliType === "claude-code" && lastContextTokens !== undefined) {
      setContextInputTokens(lastContextTokens);
      const pct = contextPct();
      if (pct < AUTO_COMPACT_RESET_THRESHOLD) {
        autoCompactTriggered = false;
      } else if (shouldAutoCompact(pct, isStreaming(), autoCompactTriggered)) {
        autoCompactTriggered = true;
        const myGen = ++pendingAutoCompactGeneration;
        queueMicrotask(() => {
          if (myGen !== pendingAutoCompactGeneration) return;
          sendAsSlashCommand(COMPACT_COMMAND, { silent: true });
        });
      }
    }
  }

  // Throttle parser → DOM updates to ~30fps. The parser's rAF already limits
  // to 60fps, but SolidJS reconciliation + virtualizer measurement at that
  // rate starves the main thread with 4+ panes streaming simultaneously.
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

    // Auto-restore last session content on mount (e.g. after app restart)
    const lastId = props.tab.lastSessionId;
    if (lastId) {
      try {
        parser.loadSession(await fetchSessionLines(props.tab, lastId));
      } catch { /* session may have been deleted */ }
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

  // Image drop events dispatched from App.tsx — co-located with cleanup via createEffect
  createEffect(() => {
    async function handleImageDrop(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { tabId, paths } = e.detail ?? {};
      if (tabId !== props.tab.id || !Array.isArray(paths)) return;
      dropHandledAt = Date.now();
      for (const p of paths) {
        if (typeof p !== "string") continue;
        try {
          const imported = await importImageFile(p);
          setAttachedImages(prev =>
            prev.some(img => img.path === imported.path)
              ? prev
              : [...prev, { name: p.split("/").pop() ?? "image", path: imported.path, mediaType: imported.mediaType }]
          );
        } catch { /* unsupported format or read error — skip */ }
      }
    }
    window.addEventListener("mlm-image-drop", handleImageDrop);
    onCleanup(() => window.removeEventListener("mlm-image-drop", handleImageDrop));
  });

  createEffect(() => {
    function handleDragState(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { tabId, over } = e.detail ?? {};
      setIsDragOver(tabId === props.tab.id && over === true);
    }
    window.addEventListener("mlm-drag-state", handleDragState);
    onCleanup(() => window.removeEventListener("mlm-drag-state", handleDragState));
  });

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

  /** Send a message to the PTY, respawning it once if the session is gone.
   *  Spinner lifecycle is managed by the caller (submitMessage) — this
   *  function only reports the outcome. */
  async function sendWithRespawn(message: string, images?: ReadonlyArray<ImageAttachmentPayload>): Promise<SendResult> {
    try {
      await sendMessageCmd(ptyId(), message, images);
      if (isCancelled()) return "error";
      store.updateStatus(props.tab.id, "running");
      return "sent";
    } catch (error: unknown) {
      const kind = classifyStreamError(error);

      // Session is busy — keep spinner visible. Caller (submitWithBusyRetry)
      // decides whether to retry; no user-visible message here so retries
      // don't spam the chat.
      if (kind === "busy") {
        store.updateStatus(props.tab.id, "running");
        return "busy";
      }

      // Session not found — respawn (e.g. after app restart with restored tabs)
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
        // Kill old session first to prevent orphaned sessions leaking in PtyManager
        await killPty(ptyId()).catch(() => {});
        if (isCancelled()) return "error";
        const newId = await spawnPty(props.tab.cliConfig);
        // Bail if the tab was closed mid-respawn (cleanup the new PTY we
        // just spawned to avoid an orphan).
        if (isCancelled() || !store.getTab(props.tab.id)) {
          await killPty(newId).catch(() => {});
          return "error";
        }
        store.updatePtyId(props.tab.id, newId);
        await sendMessageCmd(newId, message, images);
        if (isCancelled()) return "error";
        store.updateStatus(props.tab.id, "running");
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
    const images = attachedImages();
    const imagePayloads = images
      .filter(img => isValidTempImagePath(img.path) && img.mediaType)
      .map(img => ({ path: img.path, mediaType: img.mediaType }));

    parser.addUserMessage(text, images);
    setAttachedImages([]);
    setIsStreaming(true);

    await submitMessage(text, imagePayloads.length > 0 ? imagePayloads : undefined);
    // Temp files are cleaned up by the Rust reader thread after the CLI process
    // exits, not here — the CLI may still be reading them when this returns.
  }

  async function handleImageFile(file: File) {
    const WEB_SAFE = new Set(["png", "jpeg", "jpg", "gif", "webp"]);
    const ext = (file.type.split("/")[1] ?? "png").toLowerCase();
    const isWebSafe = WEB_SAFE.has(ext);

    try {
      let base64: string;
      let saveExt: string;

      if (isWebSafe) {
        base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(
            typeof reader.result === "string" ? (reader.result.split(",")[1] ?? "") : ""
          );
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        saveExt = ext === "jpg" ? "jpeg" : ext;
      } else {
        // Convert TIFF / BMP / other non-web formats to PNG via canvas
        base64 = await new Promise<string>((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement("canvas");
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            canvas.getContext("2d")?.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/png").split(",")[1] ?? "");
          };
          img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("load failed")); };
          img.src = url;
        });
        saveExt = "png";
      }

      const path = await saveTempImage(base64, saveExt);
      const name = file.name || `screenshot.${saveExt}`;
      const mediaType = `image/${saveExt}`;
      setAttachedImages(prev => [...prev, { name, path, mediaType }]);
    } catch { /* ignore */ }
  }

  function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Prefer image/png, fall back to first available image type.
    // macOS puts the same image in multiple formats (tiff + png) so we take only one.
    const imageItems = Array.from(items).filter(i => i.type.startsWith("image/"));
    const preferred = imageItems.find(i => i.type === "image/png") ?? imageItems[0];
    if (preferred) {
      e.preventDefault();
      // On macOS, pasting a file fires the Tauri drop event FIRST, then this paste event.
      // If a drop was handled within the dedup window, skip to avoid duplicating the image.
      if (Date.now() - dropHandledAt < DROP_DEDUP_WINDOW_MS) return;
      const file = preferred.getAsFile();
      if (file) handleImageFile(file);
    }
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
    "attach-file": () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => { if (input.files) Array.from(input.files).forEach(handleImageFile); };
      input.click();
    },
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
      <Show when={isDragOver()}>
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
        <Show when={stickyMessage()}>
          {(msg) => <StickyPromptHeader message={msg()} />}
        </Show>
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
            <For each={virtualizer.getVirtualItems()}>
              {(vItem) => {
                const msg = () => messages()[vItem.index];
                return (
                  <Show when={msg()}>
                    {(m) => (
                      <div
                        ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                        data-index={vItem.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${vItem.start}px)`,
                        }}
                      >
                        <MessageBubble message={m()} />
                      </div>
                    )}
                  </Show>
                );
              }}
            </For>
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
        attachedImages={attachedImages()}
        onRemoveImage={(idx) => {
          const img = attachedImages()[idx];
          if (img) deleteTempImage(img.path).catch(() => {});
          setAttachedImages(prev => prev.filter((_, i) => i !== idx));
        }}
        onSubmit={handleSubmitFromInput}
        onSlashCommand={selectSlashCommand}
        onPaste={handlePaste}
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
                onCompact: () => sendAsSlashCommand(COMPACT_COMMAND),
              }
            : undefined
        }
      />
    </div>
  );
}
