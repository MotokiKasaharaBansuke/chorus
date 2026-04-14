import { createSignal } from "solid-js";
import type { ReviewCliType } from "../types";

const [reviewCliType, setReviewCliType] = createSignal<ReviewCliType>("codex");

export function useSettingsStore() {
  return {
    get reviewCliType(): ReviewCliType { return reviewCliType(); },
    setReviewCliType(type: ReviewCliType) { setReviewCliType(type); },
  };
}
