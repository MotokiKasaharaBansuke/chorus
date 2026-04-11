import { createSignal } from "solid-js";
import { spawnPty, killPty } from "../lib/commands";
import type { CliConfig, Tab } from "../types";

export function useBottomTerminal(getWorkingDir: () => string) {
  const [showTerminal, setShowTerminal] = createSignal(false);
  const [termTabs, setTermTabs] = createSignal<Tab[]>([]);
  const [activeTermId, setActiveTermId] = createSignal<string | null>(null);
  const [termHeight, setTermHeight] = createSignal(220);

  async function addTab() {
    const config: CliConfig = { cliType: "shell", mode: "default", workingDir: getWorkingDir() || "~" };
    try {
      const id = await spawnPty(config);
      const tab: Tab = { id, title: "zsh", status: "running", cliConfig: config };
      setTermTabs(prev => [...prev, tab]);
      setActiveTermId(id);
      setShowTerminal(true);
    } catch { /* terminal open failed */ }
  }

  async function closeTab(id: string) {
    try { await killPty(id); } catch {}
    setTermTabs(prev => {
      const next = prev.filter(t => t.id !== id);
      if (activeTermId() === id) {
        setActiveTermId(next.length > 0 ? next[next.length - 1].id : null);
      }
      if (next.length === 0) setShowTerminal(false);
      return next;
    });
  }

  function toggle() {
    if (showTerminal()) {
      setShowTerminal(false);
    } else if (termTabs().length === 0) {
      addTab();
    } else {
      setShowTerminal(true);
    }
  }

  return {
    showTerminal,
    termTabs,
    activeTermId,
    setActiveTermId,
    termHeight,
    setTermHeight,
    addTab,
    closeTab,
    toggle,
    hide: () => setShowTerminal(false),
  };
}
