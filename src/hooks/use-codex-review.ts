import { createSignal } from "solid-js";
import { spawnPty, sendMessage as sendMessageCmd, gitChangedFiles } from "../lib/commands";
import { effectivePtyId } from "../types";
import type { Tab } from "../types";
import { useTabStore } from "../stores/tab-store";

const MAX_RETRY = 5;
const RETRY_DELAY_MS = 1_000;

interface UseCodexReviewParams {
  tab: Tab;
  addMessage: (text: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useCodexReview({ tab, addMessage }: UseCodexReviewParams) {
  const store = useTabStore();
  const [isReviewInProgress, setIsReviewInProgress] = createSignal(false);

  async function openCodexReviewTab(): Promise<Tab | null> {
    if (!store.canOpenTab) {
      addMessage("[Cannot open Codex tab: tab limit reached.]");
      return null;
    }

    const codexConfig = {
      cliType: "codex" as const,
      mode: "default" as const,
      workingDir: tab.cliConfig.workingDir,
    };
    const newId = await spawnPty(codexConfig);
    const newTab: Tab = {
      id: newId,
      title: `Codex ${store.tabs.length + 1}`,
      status: "running",
      cliConfig: codexConfig,
    };
    store.openTab(newTab);
    return newTab;
  }

  async function sendWithRetry(codexTab: Tab, message: string): Promise<void> {
    const ptyId = effectivePtyId(codexTab);
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      try {
        await sendMessageCmd(ptyId, message);
        return;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < MAX_RETRY - 1) await sleep(RETRY_DELAY_MS);
      }
    }
    throw lastError;
  }

  async function requestReview(): Promise<void> {
    if (isReviewInProgress()) return;
    setIsReviewInProgress(true);

    try {
      const files = await gitChangedFiles(tab.cliConfig.workingDir);
      if (files.length === 0) {
        addMessage("[No changed files detected.]");
        return;
      }

      const codexTab = await openCodexReviewTab();
      if (!codexTab) return;

      const sanitize = (name: string) => name.replace(/[`\n\r]/g, "");
      const formattedFileList = files.map((f) => `- \`${sanitize(f)}\``).join("\n");
      const reviewPrompt = `Review the following changed files:\n${formattedFileList}\n\nPlease review these changes for code quality, potential bugs, and improvements.`;

      await sendWithRetry(codexTab, reviewPrompt);
      store.updateStatus(codexTab.id, "running");
      store.setActiveTab(codexTab.id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      addMessage(`[Codex review failed: ${msg}]`);
    } finally {
      setIsReviewInProgress(false);
    }
  }

  return { requestReview, isReviewInProgress };
}
