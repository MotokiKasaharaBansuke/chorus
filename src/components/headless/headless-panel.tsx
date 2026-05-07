import { Show, createEffect, onCleanup } from "solid-js";

import { subscribeToHeadlessTab } from "../../lib/headless/event-channel";
import { useHeadlessStore } from "../../stores/headless-store";
import type { TabId } from "../../types/headless";

import { HeadlessInput } from "./headless-input";
import { MessageList } from "./messages/message-list";
import { UsageBar } from "./usage-bar";
import styles from "./headless-panel.module.css";

interface HeadlessPanelProps {
  tabId: TabId;
}

/**
 * One headless agent pane. Subscribes to the per-tab event channel on
 * mount, renders status / messages / input, and tears the listener down
 * on unmount.
 *
 * The panel is intentionally feature-equivalent to a single PTY chat
 * pane — no terminal emulator, no ANSI parsing. Memory and CPU cost
 * scale with message count, not with token volume.
 */
export function HeadlessPanel(props: HeadlessPanelProps) {
  const store = useHeadlessStore();

  createEffect(() => {
    const tabId = props.tabId;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void subscribeToHeadlessTab(tabId).then((off) => {
      if (cancelled) {
        off();
        return;
      }
      unsubscribe = off;
    });

    onCleanup(() => {
      cancelled = true;
      unsubscribe?.();
    });
  });

  const session = () => store.sessionFor(props.tabId);
  const inputDisabled = () => {
    const s = session();
    if (!s) return true;
    return s.status === "thinking" || s.status === "running" || s.status === "error";
  };

  return (
    <div class={styles.container}>
      <Show
        when={session()}
        fallback={
          <div class={styles.statusBar}>
            <span>connecting…</span>
          </div>
        }
      >
        {(s) => (
          <UsageBar
            status={s().status}
            errorKind={s().errorKind}
            errorMessage={s().errorMessage}
            usage={s().usage}
            rateLimit={s().rateLimit}
          />
        )}
      </Show>
      <div class={styles.messages}>
        <Show
          when={session() && session()!.messages.length > 0}
          fallback={
            <div class={styles.emptyState}>
              Start a conversation by sending a message below.
            </div>
          }
        >
          <MessageList messages={session()!.messages} />
        </Show>
      </div>
      <HeadlessInput tabId={props.tabId} disabled={inputDisabled()} />
    </div>
  );
}
