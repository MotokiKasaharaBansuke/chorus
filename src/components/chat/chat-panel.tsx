import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { streamEventDispatcher, ptyExitDispatcher } from "../../lib/event-dispatcher";
import { sendMessage as sendMessageCmd, killPty, spawnPty, saveTempImage, importImageFile, deleteTempImage, listSessions, readSession, listCodexSessions, readCodexSession, type SessionInfo, type ImageAttachmentPayload } from "../../lib/commands";
import { useReviewRequest } from "../../hooks/use-review-request";
import { StreamParser } from "../../lib/stream-parser";
import { MessageBubble } from "./message-bubble";
import { BusySpinner } from "./busy-spinner";
import { ModelPicker } from "./model-picker";
import { ChatInput } from "./chat-input";
import { SessionPicker } from "./session-picker";
import { ClawdIcon, CodexIcon } from "../icons";
import type { Tab, ChatMessage, AttachedImage } from "../../types";
import { effectivePtyId } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import { useSettingsStore } from "../../stores/settings-store";
import { classifyStreamError } from "../../lib/classify-error";
import { isValidTempImagePath } from "../../lib/validate-path";
import styles from "./chat-panel.module.css";


interface ChatPanelProps {
  tab: Tab;
}

export function ChatPanel(props: ChatPanelProps) {
  const store = useTabStore();
  const settings = useSettingsStore();
  /** Effective PTY ID (differs from tab.id after PTY respawn) */
  const ptyId = () => effectivePtyId(props.tab);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [attachedImages, setAttachedImages] = createSignal<AttachedImage[]>([]);
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [pastSessions, setPastSessions] = createSignal<SessionInfo[]>([]);
  const [showSessionPicker, setShowSessionPicker] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const inputHistory: string[] = [];
  let scrollRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  // On macOS, pasting a file triggers BOTH a Tauri drop event AND a DOM paste event.
  // The Tauri drop event fires FIRST, so we record when a drop was handled,
  // then suppress the subsequent DOM paste if it arrives within the dedup window.
  const DROP_DEDUP_WINDOW_MS = 500;
  let dropHandledAt = 0;

  const parser = new StreamParser();
  parser.onUpdate((msgs) => {
    setMessages([...msgs]);
    requestAnimationFrame(() => {
      if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight;
    });
  });
  // Status transitions delegated to StreamParser (avoids re-parsing the same JSON line)
  parser.onStatusChange((status) => {
    setIsStreaming(status === "streaming");
    store.updateStatus(props.tab.id, status === "streaming" ? "running" : "waiting");
  });

  // Reactive subscriptions — re-subscribe automatically when ptyId changes (e.g. after respawn)
  createEffect(() => {
    const id = ptyId();
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
              : [...prev, { name: p.split("/").pop() ?? "image", ...imported }]
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

  type SendResult = "sent" | "busy" | "error";

  /** Send a message to the PTY, respawning it once if the session is gone. */
  async function sendWithRespawn(message: string, images?: ReadonlyArray<ImageAttachmentPayload>): Promise<SendResult> {
    try {
      await sendMessageCmd(ptyId(), message, images);
      store.updateStatus(props.tab.id, "running");
      return "sent";
    } catch (error: unknown) {
      const kind = classifyStreamError(error);

      // Session is busy — keep spinner visible since the CLI is still processing
      if (kind === "busy") {
        store.updateStatus(props.tab.id, "running");
        parser.addUserMessage("[Waiting for current response to complete...]");
        return "busy";
      }

      // Session not found — respawn (e.g. after app restart with restored tabs)
      if (kind !== "not_found") {
        setIsStreaming(false);
        store.updateStatus(props.tab.id, "error");
        parser.addUserMessage("[Error: Failed to send message.]");
        return "error";
      }

      const now = Date.now();
      if (now - lastRespawnAt < 5_000) {
        setIsStreaming(false);
        store.updateStatus(props.tab.id, "error");
        parser.addUserMessage("[Error: PTY respawn failed. Please restart the tab.]");
        return "error";
      }
      try {
        lastRespawnAt = now;
        // Kill old session first to prevent orphaned sessions leaking in PtyManager
        await killPty(ptyId()).catch(() => {});
        const newId = await spawnPty(props.tab.cliConfig);
        if (!store.getTab(props.tab.id)) {
          await killPty(newId).catch(() => {});
          return "error";
        }
        store.updatePtyId(props.tab.id, newId);
        await sendMessageCmd(newId, message, images);
        store.updateStatus(props.tab.id, "running");
        return "sent";
      } catch (retryError: unknown) {
        setIsStreaming(false);
        store.updateStatus(props.tab.id, "error");
        const errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
        parser.addUserMessage(`[Error: Failed to send message. ${errorMessage}]`);
        return "error";
      }
    }
  }

  async function handleSubmitFromInput(text: string) {
    if (isStreaming()) return;
    const images = attachedImages();
    const imagePayloads = images
      .filter(img => isValidTempImagePath(img.path) && img.base64Data && img.mediaType)
      .map(img => ({ data: img.base64Data, mediaType: img.mediaType }));

    parser.addUserMessage(text, images);
    setAttachedImages([]);
    setIsStreaming(true);

    const result = await sendWithRespawn(text, imagePayloads.length > 0 ? imagePayloads : undefined);
    // Reset spinner on error, but keep it visible on "busy" (CLI is still processing)
    if (result === "error") setIsStreaming(false);
    for (const img of images) {
      deleteTempImage(img.path).catch(() => {});
    }
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
      setAttachedImages(prev => [...prev, { name, path, base64Data: base64, mediaType }]);
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

  const UI_COMMANDS: Record<string, () => void> = {
    "clear-conversation": () => { parser.loadSession([]); },
    "attach-file": () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = () => { if (input.files) Array.from(input.files).forEach(handleImageFile); };
      input.click();
    },
    "resume-conversation": () => {
      if (scrollRef) scrollRef.scrollTop = 0;
      if (messages().length > 0) { setMessages([]); parser.loadSession([]); }
    },
    "model": () => setShowModelPicker(true),
  };

  function selectSlashCommand(id: string) {
    const handler = UI_COMMANDS[id];
    if (handler) { handler(); return; }
    sendAsSlashCommand(id);
  }

  /** Send a slash command directly to the CLI */
  async function sendAsSlashCommand(id: string) {
    if (isStreaming()) return;
    const command = `/${id}`;
    parser.addUserMessage(command);
    setIsStreaming(true);
    const result = await sendWithRespawn(command);
    if (result === "error") setIsStreaming(false);
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
    try {
      await killPty(ptyId());
    } catch { /* already stopped */ }
    parser.addInterrupted();
    setIsStreaming(false);
    store.updateStatus(props.tab.id, "waiting");
  }

  function extractLastAssistantText(): string | null {
    const msgs = messages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "assistant") continue;
      const textBlocks = msgs[i].blocks
        .filter((b): b is { kind: "text"; text: string } => b.kind === "text")
        .map((b) => b.text);
      if (textBlocks.length > 0) return textBlocks.join("\n");
    }
    return null;
  }

  async function sendReviewToSource() {
    const sourceId = props.tab.sourceTabId;
    if (!sourceId) return;
    const sourceTab = store.getTab(sourceId);
    if (!sourceTab) {
      parser.addUserMessage("[Source tab no longer exists.]");
      return;
    }

    const text = extractLastAssistantText();
    if (!text) {
      parser.addUserMessage("[No review result to send.]");
      return;
    }

    const sourcePtyId = effectivePtyId(sourceTab);
    const prompt = `Here is the review result from another session:\n\n${text}\n\nPlease address the issues found in this review.`;
    try {
      await sendMessageCmd(sourcePtyId, prompt);
      store.updateStatus(sourceTab.id, "running");
      store.setActiveTab(sourceTab.id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      parser.addUserMessage(`[Failed to send review to source tab: ${msg}]`);
    }
  }

  // Review hook is always initialized; requestReview no-ops for non-CLI tabs
  // since git_changed_files will return an error for non-existent working dirs.
  const review = useReviewRequest({
    tab: props.tab,
    reviewCliType: () => settings.reviewCliType,
    addMessage: (t) => parser.addUserMessage(t),
  });

  return (
    <div class={styles.container} ref={containerRef} data-tab-id={props.tab.id}>
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
      <div ref={scrollRef} class={styles.messages} onClick={(e) => {
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
                ? "Dangerous mode — bypass permissions on"
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
        <For each={messages()}>
          {(msg) => <MessageBubble message={msg} />}
        </For>
      </div>
      <Show when={isStreaming()}>
        <BusySpinner />
      </Show>
      <Show when={props.tab.sourceTabId && !isStreaming() && messages().length > 0}>
        <button
          class={styles.sendToSourceBtn}
          onClick={sendReviewToSource}
          title="Send review result to source tab"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M14 8H2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M6 4L2 8l4 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Send review to source
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
        inputHistory={inputHistory}
      />
    </div>
  );
}
