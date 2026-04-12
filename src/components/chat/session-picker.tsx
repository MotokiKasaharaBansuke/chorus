import { createSignal, createMemo, For, Show } from "solid-js";
import type { SessionInfo } from "../../lib/commands";
import styles from "./chat-panel.module.css";

const SECONDS_PER_DAY = 86400;
const SESSION_BUCKETS: ReadonlyArray<{ label: string; maxDays: number }> = [
  { label: "Today",     maxDays: 1 },
  { label: "Yesterday", maxDays: 2 },
  { label: "Past week", maxDays: 7 },
  { label: "Older",     maxDays: Infinity },
];

function groupSessions(sessions: SessionInfo[]): Array<{ label: string; sessions: SessionInfo[] }> {
  const nowSec = Date.now() / 1000;
  const elapsedDays = (s: SessionInfo) => (nowSec - s.lastModified) / SECONDS_PER_DAY;
  return SESSION_BUCKETS.flatMap(({ label, maxDays }, i) => {
    const minDays = i === 0 ? 0 : SESSION_BUCKETS[i - 1].maxDays;
    const bucket = sessions.filter(s => elapsedDays(s) >= minDays && elapsedDays(s) < maxDays);
    return bucket.length > 0 ? [{ label, sessions: bucket }] : [];
  });
}

function formatRelativeTime(unixSec: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSec));
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

interface SessionPickerProps {
  sessions: SessionInfo[];
  onSelect: (session: SessionInfo) => void;
  onClose: () => void;
}

export function SessionPicker(props: SessionPickerProps) {
  const [search, setSearch] = createSignal("");

  const filtered = createMemo(() => {
    const q = search().toLowerCase();
    if (!q) return props.sessions;
    return props.sessions.filter(s =>
      s.firstLine.toLowerCase().includes(q) || s.sessionId.toLowerCase().includes(q)
    );
  });

  return (
    <div class={styles.sessionPickerOverlay} onClick={props.onClose}>
      <div class={styles.sessionPickerModal} onClick={e => e.stopPropagation()}>
        <div class={styles.sessionPickerHeader}>
          <span>Past Conversations</span>
          <button class={styles.sessionPickerClose} onClick={props.onClose}>×</button>
        </div>
        <div class={styles.sessionPickerSearch}>
          <input
            class={styles.sessionPickerSearchInput}
            placeholder="Search sessions..."
            value={search()}
            onInput={e => setSearch(e.currentTarget.value)}
            autofocus
          />
        </div>
        <div class={styles.sessionPickerList}>
          <Show when={filtered().length === 0}>
            <div class={styles.sessionPickerEmpty}>No sessions found</div>
          </Show>
          <For each={groupSessions(filtered())}>
            {(group) => (
              <>
                <div class={styles.sessionPickerGroup}>{group.label}</div>
                <For each={group.sessions}>
                  {(session) => (
                    <div class={styles.sessionPickerItem} onClick={() => props.onSelect(session)}>
                      <span class={styles.sessionPickerItemText}>
                        {session.firstLine || session.sessionId.slice(0, 8)}
                      </span>
                      <span class={styles.sessionPickerItemDate}>
                        {formatRelativeTime(session.lastModified)}
                      </span>
                    </div>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
