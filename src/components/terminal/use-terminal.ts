import { onCleanup, onMount } from "solid-js";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { writePty, resizePty } from "../../lib/commands";
import { ptyOutputDispatcher, ptyExitDispatcher } from "../../lib/event-dispatcher";
import { detectStatus } from "../../lib/parsers/pty-output-parser";
import type { CliType, TabStatus } from "../../types";

interface UseTerminalOptions {
  ptyId: string;
  cliType: CliType;
  onStatusChange: (status: TabStatus) => void;
}

export function useTerminal(options: UseTerminalOptions) {
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let webglAddon: WebglAddon | null = null;
  let unsubscribePtyOutput: (() => void) | null = null;
  let unsubscribePtyExit: (() => void) | null = null;
  let observer: ResizeObserver | null = null;
  let zoomHandler: ((e: Event) => void) | null = null;
  const BASE_FONT_SIZE = 13;

  function mount(container: HTMLDivElement) {
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
      theme: {
        background: "#1a1a1a",
        foreground: "#cccccc",
        cursor: "#aeafad",
        cursorAccent: "#1a1a1a",
        selectionBackground: "#264f78",
        selectionForeground: "#ffffff",
        black: "#1a1a1a",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#cccccc",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#ffffff",
      },
      scrollback: 1000,
      allowProposedApi: true,
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(container);

    // Try WebGL, fallback to canvas
    try {
      webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
    } catch {
      webglAddon = null;
    }

    fitAddon.fit();

    // Handle keyboard input → PTY
    terminal.onData(async (data) => {
      try {
        await writePty(options.ptyId, data);
      } catch {
        // PTY might be closed
      }
    });

    // Handle resize → PTY
    terminal.onResize(async ({ cols, rows }) => {
      try {
        await resizePty(options.ptyId, cols, rows);
      } catch {
        // PTY might be closed
      }
    });

    // Subscribe to PTY output via global dispatcher (one Tauri listener per event type)
    unsubscribePtyOutput = ptyOutputDispatcher.subscribe(options.ptyId, (payload) => {
      if (!terminal) return;
      terminal.write(payload.data);
      const status = detectStatus(payload.data, options.cliType);
      if (status) options.onStatusChange(status);
    });

    // Subscribe to PTY exit via global dispatcher
    unsubscribePtyExit = ptyExitDispatcher.subscribe(options.ptyId, (payload) => {
      const code = payload.code;
      options.onStatusChange(code === 0 || code === null ? "completed" : "error");
    });

    // Observe container resize
    observer = new ResizeObserver(() => {
      if (fitAddon) {
        try { fitAddon.fit(); } catch { /* ignore */ }
      }
    });
    observer.observe(container);

    // Listen for zoom changes
    zoomHandler = (e: Event) => {
      const zoom = (e as CustomEvent).detail?.zoom ?? 100;
      if (terminal) {
        terminal.options.fontSize = Math.round(BASE_FONT_SIZE * (zoom / 100));
        try { fitAddon?.fit(); } catch { /* ignore */ }
      }
    };
    window.addEventListener("mlm-zoom", zoomHandler);
  }

  function dispose() {
    if (zoomHandler) {
      window.removeEventListener("mlm-zoom", zoomHandler);
      zoomHandler = null;
    }
    observer?.disconnect();
    observer = null;
    unsubscribePtyOutput?.();
    unsubscribePtyOutput = null;
    unsubscribePtyExit?.();
    unsubscribePtyExit = null;
    webglAddon?.dispose();
    webglAddon = null;
    fitAddon?.dispose();
    fitAddon = null;
    terminal?.dispose();
    terminal = null;
  }

  function fit() {
    try { fitAddon?.fit(); } catch { /* ignore */ }
  }

  function setScrollback(lines: number) {
    if (terminal) {
      terminal.options.scrollback = lines;
    }
  }

  return { mount, dispose, fit, setScrollback };
}
