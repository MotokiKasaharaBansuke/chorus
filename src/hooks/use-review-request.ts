import { createSignal } from "solid-js";
import { spawnPty, sendMessage as sendMessageCmd, gitChangedFiles } from "../lib/commands";
import { effectivePtyId } from "../types";
import type { ReviewCliType, Tab } from "../types";
import { useTabStore } from "../stores/tab-store";

const MAX_RETRY = 5;
const RETRY_DELAY_MS = 1_000;

const CLI_LABELS: Record<ReviewCliType, string> = {
  "claude-code": "Claude",
  "codex": "Codex",
};

interface UseReviewRequestParams {
  tab: Tab;
  reviewCliType: () => ReviewCliType;
  addMessage: (text: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useReviewRequest({ tab, reviewCliType, addMessage }: UseReviewRequestParams) {
  const store = useTabStore();
  const [isReviewInProgress, setIsReviewInProgress] = createSignal(false);

  async function openReviewTab(): Promise<Tab | null> {
    if (!store.canOpenTab) {
      addMessage("[Cannot open review tab: tab limit reached.]");
      return null;
    }

    const cliType = reviewCliType();
    const config = {
      cliType,
      mode: "default" as const,
      workingDir: tab.cliConfig.workingDir,
    };
    const newId = await spawnPty(config);
    const label = CLI_LABELS[cliType];
    const newTab: Tab = {
      id: newId,
      title: `${label} ${store.tabs.length + 1}`,
      status: "running",
      cliConfig: config,
      sourceTabId: tab.id,
    };
    store.openTab(newTab);
    return newTab;
  }

  async function sendWithRetry(reviewTab: Tab, message: string): Promise<void> {
    const ptyId = effectivePtyId(reviewTab);
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

      const reviewTab = await openReviewTab();
      if (!reviewTab) return;

      const sanitize = (name: string) => name.replace(/[`\n\r]/g, "");
      const formattedFileList = files.map((f) => `- \`${sanitize(f)}\``).join("\n");
      const reviewPrompt = `Review the following changed files:\n${formattedFileList}\n\nPlease review these changes for code quality, potential bugs, and improvements.`;

      await sendWithRetry(reviewTab, reviewPrompt);
      store.updateStatus(reviewTab.id, "running");
      store.setActiveTab(reviewTab.id);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      addMessage(`[Review request failed: ${msg}]`);
    } finally {
      setIsReviewInProgress(false);
    }
  }

  return { requestReview, isReviewInProgress };
}
