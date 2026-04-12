import { createSignal } from "solid-js";

const [isSidebarOpen, setIsSidebarOpen] = createSignal(true);
const [sidebarWidth, setSidebarWidth] = createSignal(200);
const [workingDir, setWorkingDir] = createSignal("");

export function useSidebarStore() {
  return {
    get isOpen() { return isSidebarOpen(); },
    get width() { return sidebarWidth(); },
    get workingDir() { return workingDir(); },

    toggle() { setIsSidebarOpen(prev => !prev); },
    setWidth(w: number) { setSidebarWidth(Math.max(150, Math.min(500, w))); },
    setWorkingDir(dir: string) { setWorkingDir(dir); },
  };
}
