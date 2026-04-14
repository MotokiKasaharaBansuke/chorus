import { createSignal, Show, createEffect, createMemo, For, onCleanup } from "solid-js";
import { readFile } from "../../lib/commands";
import { subscribeFsChange } from "../../lib/fs-change-bus";
import { findAllMatches, type TextMatch } from "../../lib/text-search";
import styles from "./file-viewer.module.css";

interface FileViewerProps {
  path: string;
  onClose: () => void;
  contentOverride?: string;
}

const MAX_HIGHLIGHT_MATCHES = 1000;
const QUERY_DEBOUNCE_MS = 120;
const RELOAD_DEBOUNCE_MS = 120;

type Segment =
  | { kind: "text"; text: string }
  | { kind: "match"; text: string; isActive: boolean };

const KEYWORD_COLORS: Record<string, string> = {
  ts: "#3178c6", tsx: "#3178c6", js: "#f0db4f", jsx: "#f0db4f",
  rs: "#dea584", py: "#3572a5", go: "#00add8",
  css: "#563d7c", html: "#e34c26", json: "#cb8642",
  md: "#519aba", yaml: "#a074c4", toml: "#6d8086",
  sh: "#8dc149",
};

function getExt(path: string): string {
  const name = path.split("/").pop() ?? "";
  if (name.startsWith(".")) return name.slice(1);
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

export function FileViewer(props: FileViewerProps) {
  const [content, setContent] = createSignal("");
  const [error, setError] = createSignal("");
  const [isLoading, setIsLoading] = createSignal(true);
  const [isSearchOpen, setIsSearchOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const [activeIdx, setActiveIdx] = createSignal(0);

  let searchInputRef: HTMLInputElement | undefined;
  let activeMatchRef: HTMLSpanElement | undefined;

  const fileName = () => props.path.split("/").pop() ?? "";
  const ext = () => getExt(props.path);
  const accentColor = () => KEYWORD_COLORS[ext()] ?? "#6e7681";

  let loadToken = 0;

  async function loadContent(path: string) {
    const token = ++loadToken;
    setError("");
    setIsLoading(true);
    try {
      const text = await readFile(path);
      if (token !== loadToken) return;
      setContent(text);
    } catch (e) {
      if (token !== loadToken) return;
      setError(String(e));
    } finally {
      if (token === loadToken) setIsLoading(false);
    }
  }

  createEffect(() => {
    if (props.contentOverride !== undefined) {
      loadToken++;
      setContent(props.contentOverride);
      setError("");
      setIsLoading(false);
      return;
    }
    setContent("");
    loadContent(props.path);
  });

  createEffect(() => {
    if (props.contentOverride !== undefined) return;
    const path = props.path;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeFsChange((payload) => {
      if (!payload.paths.includes(path)) return;
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        loadContent(path);
      }, RELOAD_DEBOUNCE_MS);
    });
    onCleanup(() => {
      if (pending !== null) clearTimeout(pending);
      unsubscribe();
    });
  });

  // Debounce query input so large files don't re-scan the entire buffer on
  // every keystroke.
  createEffect(() => {
    const q = query();
    const handle = setTimeout(() => setDebouncedQuery(q), QUERY_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(handle));
  });

  const searchResult = createMemo(() =>
    findAllMatches(content(), debouncedQuery(), MAX_HIGHLIGHT_MATCHES),
  );
  const matches = createMemo<TextMatch[]>(() => searchResult().matches);
  const isTruncated = () => searchResult().truncated;

  createEffect(() => {
    matches();
    setActiveIdx(0);
  });

  createEffect(() => {
    activeIdx();
    matches();
    queueMicrotask(() => {
      activeMatchRef?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  function step(delta: number) {
    const total = matches().length;
    if (total === 0) return;
    setActiveIdx((prev) => (prev + delta + total) % total);
  }

  function openSearch() {
    setIsSearchOpen(true);
    queueMicrotask(() => searchInputRef?.focus());
  }

  function closeSearch() {
    setIsSearchOpen(false);
    setQuery("");
  }

  function onKeyDown(e: KeyboardEvent) {
    const isFind = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f";
    if (isFind) {
      e.preventDefault();
      if (isSearchOpen()) searchInputRef?.focus();
      else openSearch();
      return;
    }
    if (e.key === "Escape" && isSearchOpen()) {
      e.preventDefault();
      closeSearch();
    }
  }

  function onSearchKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    }
  }

  const lineCount = () => content().split("\n").length;

  const segments = createMemo<Segment[]>(() => {
    const text = content();
    const ms = matches();
    if (ms.length === 0) return [{ kind: "text", text }];
    const active = activeIdx();
    const result: Segment[] = [];
    let cursor = 0;
    ms.forEach((m, i) => {
      if (m.start > cursor) result.push({ kind: "text", text: text.slice(cursor, m.start) });
      result.push({ kind: "match", text: text.slice(m.start, m.end), isActive: i === active });
      cursor = m.end;
    });
    if (cursor < text.length) result.push({ kind: "text", text: text.slice(cursor) });
    return result;
  });

  return (
    <div class={styles.viewer} onKeyDown={onKeyDown} tabIndex={-1}>
      <div class={styles.header} style={{ "border-top-color": accentColor() }}>
        <span class={styles.fileName}>{fileName()}</span>
        <span class={styles.filePath}>{props.path}</span>
      </div>
      <Show when={isSearchOpen()}>
        <div class={styles.searchBar}>
          <input
            ref={searchInputRef}
            class={styles.searchInput}
            type="text"
            placeholder="Find in file"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
          <span class={styles.searchCount}>
            {matches().length === 0
              ? "No results"
              : `${activeIdx() + 1} of ${matches().length}${isTruncated() ? "+" : ""}`}
          </span>
          <button
            class={styles.searchBtn}
            onClick={() => step(-1)}
            disabled={matches().length === 0}
            title="Previous (Shift+Enter)"
          >
            ↑
          </button>
          <button
            class={styles.searchBtn}
            onClick={() => step(1)}
            disabled={matches().length === 0}
            title="Next (Enter)"
          >
            ↓
          </button>
          <button class={styles.searchBtn} onClick={closeSearch} title="Close (Esc)">×</button>
        </div>
      </Show>
      <div class={styles.body}>
        <Show when={isLoading()}>
          <div class={styles.loading}>Loading…</div>
        </Show>
        <Show when={error()}>
          <div class={styles.error}>{error()}</div>
        </Show>
        <Show when={!isLoading() && !error()}>
          <div class={styles.codeContainer}>
            <div class={styles.lineNumbers}>
              {Array.from({ length: lineCount() }, (_, i) => (
                <div class={styles.lineNum}>{i + 1}</div>
              ))}
            </div>
            <pre class={styles.code}>
              <For each={segments()}>
                {(seg) =>
                  seg.kind === "text" ? (
                    seg.text
                  ) : (
                    <span
                      ref={(el) => { if (seg.isActive) activeMatchRef = el; }}
                      class={seg.isActive ? styles.activeMatch : styles.match}
                    >
                      {seg.text}
                    </span>
                  )
                }
              </For>
            </pre>
          </div>
        </Show>
      </div>
    </div>
  );
}
