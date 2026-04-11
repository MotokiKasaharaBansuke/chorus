import { createSignal, onCleanup, onMount } from "solid-js";
import styles from "./chat-panel.module.css";

const ICONS = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];

const VERBS = [
  "Accomplishing", "Actioning", "Baking", "Booping", "Brewing",
  "Calculating", "Cerebrating", "Churning", "Clauding", "Cogitating",
  "Computing", "Concocting", "Contemplating", "Cooking", "Crafting",
  "Crunching", "Deciphering", "Deliberating", "Doing", "Enchanting",
  "Envisioning", "Finagling", "Forging", "Generating", "Hatching",
  "Ideating", "Imagining", "Inferring", "Manifesting", "Mulling",
  "Musing", "Noodling", "Percolating", "Philosophising", "Pondering",
  "Processing", "Puzzling", "Ruminating", "Scheming", "Simmering",
  "Spinning", "Stewing", "Synthesizing", "Thinking", "Tinkering",
  "Transmuting", "Unfurling", "Vibing", "Whirring", "Working",
];

function pickRandom(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function BusySpinner() {
  const [iconIdx, setIconIdx] = createSignal(0);
  const [verb, setVerb] = createSignal(pickRandom(VERBS));

  onMount(() => {
    // Rotate icon
    const iconTimer = setInterval(() => {
      setIconIdx(prev => (prev + 1) % ICONS.length);
    }, 120);

    // Change verb periodically
    const verbTimer = setInterval(() => {
      setVerb(pickRandom(VERBS));
    }, 4000);

    onCleanup(() => {
      clearInterval(iconTimer);
      clearInterval(verbTimer);
    });
  });

  return (
    <div class={styles.busySpinner}>
      <span class={styles.busyIcon}>{ICONS[iconIdx()]}</span>
      <span class={styles.busyText}>{verb()}...</span>
    </div>
  );
}
