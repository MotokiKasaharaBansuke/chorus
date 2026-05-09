/**
 * Interactive question card for Claude Code's `AskUserQuestion` tool.
 *
 * When headless mode encounters an `AskUserQuestion` tool_use, the turn
 * ends with an error (stdin is closed). This card renders the question
 * options so the user can pick an answer, which is then sent as a new
 * turn via the `mlm-ask-user-answer` custom event.
 */
import { createSignal, For, Show } from "solid-js";
import type { AskUserQuestionItem } from "../../types";
import styles from "./ask-user-question-card.module.css";

interface AskUserQuestionCardProps {
  toolId: string;
  questions: AskUserQuestionItem[];
  answered: boolean;
  tabId: string;
}

export function AskUserQuestionCard(props: AskUserQuestionCardProps) {
  // Card-level submitted state: once any group dispatches, all groups
  // are disabled to prevent a second group from racing with the model.
  const [submitted, setSubmitted] = createSignal(false);
  const isDisabled = () => props.answered || submitted() || !props.tabId;

  function onDispatch(answer: string) {
    if (isDisabled()) return;
    setSubmitted(true);
    dispatchAnswer(props.tabId, answer);
  }

  return (
    <div class={styles.card}>
      <For each={props.questions}>
        {(question) => (
          <QuestionGroup
            question={question}
            disabled={isDisabled()}
            onDispatch={onDispatch}
          />
        )}
      </For>
    </div>
  );
}

interface QuestionGroupProps {
  question: AskUserQuestionItem;
  disabled: boolean;
  onDispatch: (answer: string) => void;
}

function QuestionGroup(props: QuestionGroupProps) {
  const [selected, setSelected] = createSignal<Set<number>>(new Set());

  function handleSelect(index: number) {
    if (props.disabled) return;

    if (props.question.isMultiSelect) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else {
      const option = props.question.options[index];
      if (!option) return;
      props.onDispatch(option.description);
    }
  }

  function handleMultiSubmit() {
    if (props.disabled || selected().size === 0) return;
    const descriptions = [...selected()]
      .sort((a, b) => a - b)
      .map((i) => props.question.options[i]?.description)
      .filter(Boolean);
    const answer =
      descriptions.length === 1
        ? descriptions[0]!
        : descriptions.map((d) => `- ${d}`).join("\n");
    props.onDispatch(answer);
  }

  return (
    <div class={styles.group}>
      <div class={styles.header}>{props.question.header}</div>
      <div class={styles.options}>
        <For each={props.question.options}>
          {(option, index) => {
            const isSelected = () => selected().has(index());
            return (
              <button
                class={`${styles.option} ${isSelected() ? styles.optionSelected : ""}`}
                disabled={props.disabled}
                onClick={() => handleSelect(index())}
              >
                <Show when={props.question.isMultiSelect}>
                  <span class={styles.checkbox}>
                    {isSelected() ? "☑" : "☐"}
                  </span>
                </Show>
                <span class={styles.optionText}>{option.description}</span>
              </button>
            );
          }}
        </For>
      </div>
      <Show when={props.question.isMultiSelect && !props.disabled}>
        <button
          class={styles.submitBtn}
          disabled={selected().size === 0}
          onClick={handleMultiSubmit}
        >
          Submit ({selected().size})
        </button>
      </Show>
      <Show when={props.disabled}>
        <div class={styles.answered}>Answered</div>
      </Show>
    </div>
  );
}

function dispatchAnswer(tabId: string, answer: string) {
  window.dispatchEvent(
    new CustomEvent("mlm-ask-user-answer", {
      detail: { tabId, answer },
    }),
  );
}
