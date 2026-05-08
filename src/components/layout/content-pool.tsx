import { createContext, useContext, createSignal, For, Show, onCleanup, type JSX, type Accessor } from "solid-js";
import { ChatPanel } from "../chat/chat-panel";
import { HeadlessPanel } from "../headless/headless-panel";
import { TerminalPanel } from "../terminal/terminal-panel";
import { FileViewer } from "../sidebar/file-viewer";
import type { Tab } from "../../types";
import { effectivePaneKind } from "../../types";

interface ContentPoolContextValue {
  /** Get the pool DOM element for a tab so PaneGroup can move it into a slot. */
  getContentEl: (tabId: string) => HTMLDivElement | undefined;
  /** Reactive signal that increments when pool refs are added/removed.
   *  PaneGroup createEffects should read this to re-run when content appears. */
  version: Accessor<number>;
}

const ContentPoolCtx = createContext<ContentPoolContextValue>();

export function useContentPool(): ContentPoolContextValue {
  const ctx = useContext(ContentPoolCtx);
  if (!ctx) throw new Error("useContentPool must be used within ContentPool");
  return ctx;
}

interface ContentPoolProps {
  tabIds: () => string[];
  getTab: (id: string) => Tab | undefined;
  isTabActive: (id: string) => boolean;
  onCloseTab: (id: string) => void;
  children?: JSX.Element;
}

export function ContentPool(props: ContentPoolProps) {
  const refs = new Map<string, HTMLDivElement>();
  const [version, setVersion] = createSignal(0);

  const ctxValue: ContentPoolContextValue = {
    getContentEl: (tabId) => refs.get(tabId),
    version,
  };

  return (
    <ContentPoolCtx.Provider value={ctxValue}>
      {/* Hidden container -- content is moved to PaneGroup slots via appendChild */}
      <div style={{ position: "absolute", width: "0", height: "0", overflow: "hidden", "pointer-events": "none" }}>
        <For each={props.tabIds()}>
          {(tabId) => {
            onCleanup(() => {
              refs.delete(tabId);
              setVersion(v => v + 1);
            });

            return (
              <Show when={props.getTab(tabId)}>
                {(tab) => (
                  <div
                    ref={(el) => {
                      if (!el || refs.get(tabId) === el) return;
                      refs.set(tabId, el);
                      setVersion(v => v + 1);
                    }}
                    data-pool-tab={tabId}
                    style={{ display: "flex", "flex-direction": "column", flex: "1", width: "100%", height: "100%" }}
                  >
                    <PooledContent
                      tab={tab()}
                      isActive={() => props.isTabActive(tabId)}
                      onClose={() => props.onCloseTab(tabId)}
                    />
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
      {props.children}
    </ContentPoolCtx.Provider>
  );
}

/** Dispatches to the correct content component based on CLI type and
 *  pane kind. Created once per tab by `<For>` — tab identity is stable
 *  for the lifetime of this component, so the eager `cliType` /
 *  `paneKind` read is safe. `isActive` is an accessor to keep SolidJS
 *  reactivity. */
function PooledContent(props: { tab: Tab; isActive: () => boolean; onClose: () => void }) {
  if (props.tab.cliConfig.cliType === "file-viewer" && props.tab.filePath) {
    return <FileViewer path={props.tab.filePath} onClose={props.onClose} contentOverride={props.tab.contentOverride} />;
  }
  if (props.tab.cliConfig.cliType === "claude-code" || props.tab.cliConfig.cliType === "codex") {
    if (effectivePaneKind(props.tab) === "headless") {
      return <HeadlessPanel tab={props.tab} />;
    }
    return <ChatPanel tab={props.tab} isActive={props.isActive} />;
  }
  return <TerminalPanel tab={props.tab} isActive={props.isActive} />;
}
