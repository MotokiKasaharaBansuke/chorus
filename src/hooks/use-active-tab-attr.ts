import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { Tab } from "../types";

interface ActiveTabAttrOptions<T> {
  activeTab: () => Tab | null;
  /** Cached value on the tab (e.g. `tab.worktree?.branch`). */
  pick: (tab: Tab) => T | null | undefined;
  /** Async fallback invoked with the tab's working directory. */
  resolve: (workingDir: string) => Promise<T | null>;
}

/**
 * Reactive derivation of a per-tab attribute: use the cached value if present,
 * otherwise resolve it from the tab's working directory. Re-runs on active-tab
 * change. Used by the sidebar to display the focused pane's branch / repo root.
 *
 * In-flight `resolve()` promises from a prior active tab are cancelled via a
 * per-effect flag so their late resolution cannot overwrite a newer tab's value.
 */
export function useActiveTabAttr<T>(options: ActiveTabAttrOptions<T>): Accessor<T | null> {
  const [value, setValue] = createSignal<T | null>(null);
  createEffect(() => {
    const tab = options.activeTab();
    if (!tab) { setValue(null); return; }
    const cached = options.pick(tab);
    if (cached != null) { setValue(() => cached); return; }
    const dir = tab.cliConfig.workingDir;
    if (!dir) { setValue(null); return; }

    let cancelled = false;
    onCleanup(() => { cancelled = true; });
    options.resolve(dir)
      .then((v) => { if (!cancelled) setValue(() => v); })
      .catch(() => { if (!cancelled) setValue(null); });
  });
  return value;
}
