import { For, Show, createSignal, onMount, onCleanup } from "solid-js";
import { useSettingsStore } from "../../stores/settings-store";
import type { AccountProfile } from "../../types/settings";
import styles from "./account-picker.module.css";

interface AccountPickerProps {
  currentAccountId?: string;
  onSelect: (accountId: string | undefined) => void;
  onDelete: (deletedId: string) => void;
  onClose: () => void;
}

export function AccountPicker(props: AccountPickerProps) {
  const settings = useSettingsStore();
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [newConfigDir, setNewConfigDir] = createSignal("");
  const [focusedIndex, setFocusedIndex] = createSignal(0);

  const items = () => [
    { id: undefined as string | undefined, name: "Default account", desc: "System Claude Code login" },
    ...settings.accounts.map(a => ({
      id: a.id as string | undefined,
      name: a.name,
      desc: a.claudeConfigDir ? `Config dir: ${a.claudeConfigDir}` : "Custom account",
    })),
  ];

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showAddForm()) return;
    const list = items();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex(i => (i + 1) % list.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex(i => (i - 1 + list.length) % list.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const item = list[focusedIndex()];
      if (item) { props.onSelect(item.id); props.onClose(); }
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => window.addEventListener("keydown", handleKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown, true));

  function handleAddAccount() {
    const name = newName().trim();
    const dir = newConfigDir().trim();
    if (!name) return;
    if (dir && (dir.includes("..") || dir.includes("\0"))) return;

    const profile: AccountProfile = {
      id: crypto.randomUUID(),
      name,
      claudeConfigDir: dir || undefined,
    };
    settings.addAccount(profile);
    setNewName("");
    setNewConfigDir("");
    setShowAddForm(false);
  }

  function handleDelete(id: string, e: MouseEvent) {
    e.stopPropagation();
    settings.removeAccount(id);
    props.onDelete(id);
  }

  return (
    <div class={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div class={styles.modal}>
        <div class={styles.title}>Switch account</div>
        <For each={items()}>
          {(item, idx) => {
            const isSelected = () => props.currentAccountId === item.id;
            const isFocused = () => !showAddForm() && focusedIndex() === idx();
            return (
              <div
                classList={{
                  [styles.item]: true,
                  [styles.itemSelected]: isSelected(),
                  [styles.itemFocused]: isFocused(),
                }}
                onClick={() => { props.onSelect(item.id); props.onClose(); }}
                onMouseEnter={() => { if (!showAddForm()) setFocusedIndex(idx()); }}
              >
                <div>
                  <div class={styles.itemLabel}>{item.name}</div>
                  <div class={styles.itemDesc}>{item.desc}</div>
                </div>
                <div class={styles.itemActions}>
                  <Show when={isSelected()}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M3 8l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </Show>
                  <Show when={item.id !== undefined}>
                    <button
                      class={styles.deleteBtn}
                      onClick={(e) => handleDelete(item.id as string, e)}
                      title="Remove account"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                      </svg>
                    </button>
                  </Show>
                </div>
              </div>
            );
          }}
        </For>

        <Show when={!showAddForm()}>
          <button class={styles.addBtn} onClick={() => setShowAddForm(true)}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
            Add account…
          </button>
        </Show>

        <Show when={showAddForm()}>
          <div class={styles.addForm} onClick={(e) => e.stopPropagation()}>
            <div class={styles.addFormTitle}>Add account</div>
            <input
              class={styles.input}
              type="text"
              placeholder="Name (e.g. Work)"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              autofocus
            />
            <input
              class={styles.input}
              type="text"
              placeholder="CLAUDE_CONFIG_DIR (e.g. ~/.claude-work)"
              value={newConfigDir()}
              onInput={(e) => setNewConfigDir(e.currentTarget.value)}
            />
            <div class={styles.addFormHint}>
              Leave config dir empty to use default auth with a different name label.
            </div>
            <div class={styles.addFormActions}>
              <button class={styles.cancelBtn} onClick={() => setShowAddForm(false)}>Cancel</button>
              <button class={styles.confirmBtn} onClick={handleAddAccount} disabled={!newName().trim()}>Add</button>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
