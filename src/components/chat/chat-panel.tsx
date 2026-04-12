import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { streamEventDispatcher, ptyExitDispatcher } from "../../lib/event-dispatcher";
import { sendMessage as sendMessageCmd, killPty, spawnPty, saveTempImage, deleteTempImage, listSessions, readSession, listCodexSessions, readCodexSession, type SessionInfo } from "../../lib/commands";
import { StreamParser } from "../../lib/stream-parser";
import { MessageBubble } from "./message-bubble";
import { BusySpinner } from "./busy-spinner";
import { ModelPicker } from "./model-picker";
import { ChatInput } from "./chat-input";
import { SessionPicker } from "./session-picker";
import { ClawdIcon, CodexIcon } from "../icons";
import type { Tab, ChatMessage } from "../../types";
import { effectivePtyId } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import styles from "./chat-panel.module.css";


interface ChatPanelProps {
  tab: Tab;
}

/** True only for paths that Chorus wrote into the temp image directory (no traversal). */
function isValidTempImagePath(p: string): boolean {
  return p.startsWith("/tmp/chorus-images/")
    && !p.includes("..")
    && !p.includes("\n")
    && !p.includes("\r");
}

export function ChatPanel(props: ChatPanelProps) {
  const store = useTabStore();
  /** Effective PTY ID (differs from tab.id after PTY respawn) */
  const ptyId = () => effectivePtyId(props.tab);
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [attachedImages, setAttachedImages] = createSignal<Array<{ name: string; path: string }>>([]);
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
    function handleImageDrop(e: Event) {
      if (!(e instanceof CustomEvent)) return;
      const { tabId, paths } = e.detail ?? {};
      if (tabId !== props.tab.id || !Array.isArray(paths)) return;
      dropHandledAt = Date.now();
      for (const p of paths) {
        if (typeof p !== "string" || !isValidTempImagePath(p)) continue;
        setAttachedImages(prev =>
          prev.some(img => img.path === p)
            ? prev
            : [...prev, { name: p.split("/").pop() ?? "image", path: p }]
        );
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

  /** Send a message to the PTY, respawning it once if the session is gone. */
  async function sendWithRespawn(message: string): Promise<boolean> {
    try {
      await sendMessageCmd(ptyId(), message);
      store.updateStatus(props.tab.id, "running");
      return true;
    } catch {
      // PTY session may not exist (e.g. after app restart with restored tabs)
      const now = Date.now();
      if (now - lastRespawnAt < 5_000) {
        setIsStreaming(false);
        store.updateStatus(props.tab.id, "error");
        parser.addUserMessage("[Error: PTY respawn failed. Please restart the tab.]");
        return false;
      }
      try {
        lastRespawnAt = now;
        const newId = await spawnPty(props.tab.cliConfig);
        if (!store.getTab(props.tab.id)) {
          await killPty(newId).catch(() => {});
          return false;
        }
        store.updatePtyId(props.tab.id, newId);
        await sendMessageCmd(newId, message);
        store.updateStatus(props.tab.id, "running");
        return true;
      } catch (retryError) {
        setIsStreaming(false);
        store.updateStatus(props.tab.id, "error");
        const errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
        parser.addUserMessage(`[Error: Failed to send message. ${errorMessage}]`);
        return false;
      }
    }
  }

  async function handleSubmitFromInput(text: string) {
    let fullMessage = text;
    const images = attachedImages();
    if (images.length > 0) {
      const imagePrefixes = images
        .map(img => img.path)
        .filter(isValidTempImagePath)
        .map(p => `/image ${p}`)
        .join("\n");
      if (imagePrefixes) fullMessage = `${imagePrefixes}\n${fullMessage}`;
    }

    parser.addUserMessage(text + (images.length > 0 ? ` [${images.length} image(s)]` : ""));
    setAttachedImages([]);
    setIsStreaming(true);

    const sent = await sendWithRespawn(fullMessage);
    // Ensure isStreaming is reset on any failure path that sendWithRespawn may not cover
    if (!sent) setIsStreaming(false);
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
      setAttachedImages(prev => [...prev, { name, path }]);
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
    const command = `/${id}`;
    parser.addUserMessage(command);
    setIsStreaming(true);
    const sent = await sendWithRespawn(command);
    if (!sent) setIsStreaming(false);
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

  return (
    <div class={styles.container} ref={containerRef}>
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
      <div ref={scrollRef} class={styles.messages}>
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
        inputHistory={inputHistory}
      />
    </div>
  );
}
