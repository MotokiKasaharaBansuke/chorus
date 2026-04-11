import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { sendMessage as sendMessageCmd, saveTempImage, deleteTempImage, listSessions, readSession, type SessionInfo } from "../../lib/commands";
import { StreamParser } from "../../lib/stream-parser";
import { MessageBubble } from "./message-bubble";
import { BusySpinner } from "./busy-spinner";
import { ModelPicker } from "./model-picker";
import { ChatInput } from "./chat-input";
import { ClawdIcon, CodexIcon } from "../icons";
import type { Tab, ChatMessage } from "../../types";
import { useTabStore } from "../../stores/tab-store";
import styles from "./chat-panel.module.css";


interface ChatPanelProps {
  tab: Tab;
}

export function ChatPanel(props: ChatPanelProps) {
  const store = useTabStore();
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [attachedImages, setAttachedImages] = createSignal<Array<{ name: string; path: string }>>([]);
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [pastSessions, setPastSessions] = createSignal<SessionInfo[]>([]);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const inputHistory: string[] = [];
  let scrollRef: HTMLDivElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  let unlisten: UnlistenFn | null = null;
  let exitUnlisten: UnlistenFn | null = null;
  let imageDropHandler: ((e: Event) => void) | null = null;
  let dragStateHandler: ((e: Event) => void) | null = null;
  // On macOS, pasting a file triggers BOTH a Tauri drop event AND a DOM paste event.
  // The Tauri drop event fires FIRST, so we record when a drop was handled,
  // then suppress the subsequent DOM paste if it arrives within 500ms.
  let dropHandledAt = 0;

  const parser = new StreamParser();
  parser.onUpdate((msgs) => {
    setMessages([...msgs]);
    // Auto-scroll
    requestAnimationFrame(() => {
      if (scrollRef) {
        scrollRef.scrollTop = scrollRef.scrollHeight;
      }
    });
    // Status is managed by stream-event listener, not here
    // (matches extension behavior: busy from init until result)
  });

  onMount(async () => {
    unlisten = await listen<{ id: string; data: string }>("stream-event", (event) => {
      if (event.payload.id === props.tab.id) {
        parser.processLine(event.payload.data);
        // Match extension: busy until "result" event
        try {
          const d = JSON.parse(event.payload.data);
          if (d.type === "system" && d.subtype === "init") {
            setIsStreaming(true);
            store.updateStatus(props.tab.id, "running");
          } else if (d.type === "result" || d.type === "turn_complete") {
            setIsStreaming(false);
            store.updateStatus(props.tab.id, "waiting");
          }
        } catch { /* ignore */ }
      }
    });

    exitUnlisten = await listen<{ id: string; code: number | null }>("pty-exit", (event) => {
      if (event.payload.id === props.tab.id) {
        store.updateStatus(props.tab.id, event.payload.code === 0 ? "completed" : "error");
      }
    });

    // Load past sessions (Claude Code only — stored in ~/.claude/projects/)
    if (props.tab.cliConfig.cliType === "claude-code") try {
      const sessions = await listSessions(props.tab.cliConfig.workingDir);
      setPastSessions(sessions);
    } catch { /* ignore */ }

    // Listen for image drop events dispatched from App.tsx
    imageDropHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === props.tab.id && detail?.paths) {
        dropHandledAt = Date.now(); // Record so handlePaste can skip if it fires next
        for (const p of detail.paths as string[]) {
          // Skip if this path is already attached (guards against duplicate events)
          setAttachedImages(prev => {
            if (prev.some(img => img.path === p)) return prev;
            return [...prev, { name: p.split("/").pop() ?? "image", path: p }];
          });
        }
      }
    };
    window.addEventListener("mlm-image-drop", imageDropHandler);

    dragStateHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.tabId === null) {
        setIsDragOver(false);
      } else if (detail?.tabId === props.tab.id) {
        setIsDragOver(detail.over);
      } else {
        setIsDragOver(false);
      }
    };
    window.addEventListener("mlm-drag-state", dragStateHandler);
  });

  onCleanup(() => {
    unlisten?.();
    exitUnlisten?.();
    if (imageDropHandler) window.removeEventListener("mlm-image-drop", imageDropHandler);
    if (dragStateHandler) window.removeEventListener("mlm-drag-state", dragStateHandler);
  });

  async function handleSubmitFromInput(text: string) {
    let fullMessage = text;
    const images = attachedImages();
    if (images.length > 0) {
      for (const img of images) {
        fullMessage = `/image ${img.path}\n${fullMessage}`;
      }
    }

    parser.addUserMessage(text + (images.length > 0 ? ` [${images.length} image(s)]` : ""));
    setAttachedImages([]);
    setIsStreaming(true);

    try {
      await sendMessageCmd(props.tab.id, fullMessage);
      store.updateStatus(props.tab.id, "running");
    } catch {
      setIsStreaming(false);
    }
    for (const img of images) {
      deleteTempImage(img.path).catch(() => {});
    }
  }

  async function handleImageFile(file: File) {
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = (reader.result as string).split(",")[1];
      const ext = file.type.split("/")[1] ?? "png";
      try {
        const path = await saveTempImage(base64, ext);
        setAttachedImages(prev => [...prev, { name: file.name, path }]);
      } catch { /* ignore */ }
    };
    reader.readAsDataURL(file);
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
      // If a drop was handled within the last 500ms, skip to avoid duplicating the image.
      if (Date.now() - dropHandledAt < 500) return;
      const file = preferred.getAsFile();
      if (file) handleImageFile(file);
    }
  }

  function selectSlashCommand(id: string) {

    switch (id) {
      // --- UI actions ---
      case "clear-conversation":
        setMessages([]);
        parser.loadSession([]);
        return;

      case "attach-file": {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.multiple = true;
        input.onchange = () => {
          if (input.files) {
            for (const file of Array.from(input.files)) {
              handleImageFile(file);
            }
          }
        };
        input.click();
        return;
      }

      case "mention-file":
        // Handled by ChatInput or sent as slash command
        sendAsSlashCommand("mention-file");
        return;

      case "resume-conversation":
        // Scroll to welcome screen where past sessions are displayed
        if (scrollRef) scrollRef.scrollTop = 0;
        // If no messages, past sessions are already visible
        if (messages().length > 0) {
          setMessages([]);
          parser.loadSession([]);
        }
        return;

      case "model":
        setShowModelPicker(true);
        return;

      // --- CLI pass-through (send as slash command text) ---
      case "compact":
      case "init":
      case "review":
      case "add-feature":
      case "fix-bug":
      case "refactor":
      case "debug":
      case "security-review":
      case "simplify":
      case "cost":
      case "context":
      case "effort":
      case "thinking":
      case "account":
      case "toggle-fast":
      case "mcp-config":
      case "config":
        sendAsSlashCommand(id);
        return;

      default:
        sendAsSlashCommand(id);
        return;
    }
  }

  /** Send a slash command directly to the CLI */
  async function sendAsSlashCommand(id: string) {
    const command = `/${id}`;
    parser.addUserMessage(command);
    setIsStreaming(true);
    try {
      await sendMessageCmd(props.tab.id, command);
      store.updateStatus(props.tab.id, "running");
    } catch {
      setIsStreaming(false);
    }
  }


  function handleModelSelect(modelId: string) {
    store.updateModel(props.tab.id, modelId || undefined);
    // Also notify the CLI about model change
    sendAsSlashCommand(`model ${modelId || "default"}`);
  }

  return (
    <div class={styles.container} ref={containerRef}>
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
                    <div class={styles.pastSessionItem} onClick={async () => {
                      try {
                        const lines = await readSession(props.tab.cliConfig.workingDir, session.sessionId);
                        parser.loadSession(lines);
                      } catch { /* session load failed */ }
                    }}>
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
        inputHistory={inputHistory}
      />
    </div>
  );
}
