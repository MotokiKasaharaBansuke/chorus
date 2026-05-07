import type { HeadlessToolCall } from "../../../../types/headless";

import styles from "../messages.module.css";

interface GenericToolProps {
  call: HeadlessToolCall;
}

/**
 * Fallback tool renderer.
 *
 * Used for any tool we do not have a specialised view for. JSON-stringify
 * the input as a debugging aid — never `innerHTML`, never parsed as
 * Markdown, so even a hostile tool input cannot escape the `<pre>`.
 */
export function GenericTool(props: GenericToolProps) {
  const inputText = () => {
    try {
      return JSON.stringify(props.call.input, null, 2);
    } catch {
      return "(input not serializable)";
    }
  };

  return (
    <div class={styles.toolCallBody}>
      <pre>{inputText()}</pre>
    </div>
  );
}
