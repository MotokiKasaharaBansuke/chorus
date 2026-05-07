import styles from "./messages.module.css";

interface UserMessageProps {
  text: string;
}

/**
 * Single user turn. Plain-text rendering only — never interpret as
 * Markdown so a user pasting `<script>` cannot self-XSS via the bubble.
 */
export function UserMessage(props: UserMessageProps) {
  return (
    <div class={`${styles.message} ${styles.userMessage}`}>
      <div class={styles.userBubble}>{props.text}</div>
    </div>
  );
}
