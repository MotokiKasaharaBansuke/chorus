/** Claude Code official robot icon (Clawd) */
export function ClawdIcon(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <svg width={s} height={s} viewBox="0 0 47 38" fill="none">
      <path d="M5.08191 10.0769V0.938461H9.37422V10.0769H5.08191ZM9.23305 10.0769V0.938461H13.5254V10.0769H9.23305ZM13.3842 10.0769V0.938461H17.6765V10.0769H13.3842ZM17.5353 10.0769V0.938461H21.8276V10.0769H17.5353ZM21.6865 10.0769V0.938461H25.9788V10.0769H21.6865ZM25.8376 10.0769V0.938461H30.1299V10.0769H25.8376ZM29.9888 10.0769V0.938461H34.2811V10.0769H29.9888ZM34.1399 10.0769V0.938461H38.4322V10.0769H34.1399ZM38.291 10.0769V0.938461H42.5834V10.0769H38.291ZM0.930769 19.0769V9.93846H5.22308V19.0769H0.930769ZM5.08191 19.0769V9.93846H9.37422V19.0769H5.08191ZM9.23305 19.0769V14.5077H13.5254V19.0769H9.23305ZM13.3842 19.0769V9.93846H17.6765V19.0769H13.3842ZM17.5353 19.0769V9.93846H21.8276V19.0769H17.5353ZM21.6865 19.0769V9.93846H25.9788V19.0769H21.6865ZM25.8376 19.0769V9.93846H30.1299V19.0769H25.8376ZM29.9888 19.0769V9.93846H34.2811V19.0769H29.9888ZM34.1399 19.0769V14.5077H38.4322V19.0769H34.1399ZM38.291 19.0769V9.93846H42.5834V19.0769H38.291ZM42.4422 19.0769V9.93846H46.7345V19.0769H42.4422ZM5.08191 28.0769V18.9385H9.37422V28.0769H5.08191ZM9.23305 28.0769V18.9385H13.5254V28.0769H9.23305ZM13.3842 28.0769V18.9385H17.6765V28.0769H13.3842ZM17.5353 28.0769V18.9385H21.8276V28.0769H17.5353ZM21.6865 28.0769V18.9385H25.9788V28.0769H21.6865ZM25.8376 28.0769V18.9385H30.1299V28.0769H25.8376ZM29.9888 28.0769V18.9385H34.2811V28.0769H29.9888ZM34.1399 28.0769V18.9385H38.4322V28.0769H34.1399ZM38.291 28.0769V18.9385H42.5834V28.0769H38.291ZM5.08191 37.0769V27.9385H9.37422V37.0769H5.08191ZM13.3842 37.0769V27.9385H17.6765V37.0769H13.3842ZM29.9888 37.0769V27.9385H34.2811V37.0769H29.9888ZM38.291 37.0769V27.9385H42.5834V37.0769H38.291Z" fill="#D97757"/>
    </svg>
  );
}

/** Codex (OpenAI) icon */
export function CodexIcon(props: { size?: number }) {
  const s = props.size ?? 24;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M22.282 9.821a6.058 6.058 0 00-.52-4.99 6.11 6.11 0 00-6.59-2.934A6.058 6.058 0 0011.622 0a6.11 6.11 0 00-5.826 4.206 6.058 6.058 0 00-4.048 2.932 6.11 6.11 0 00.75 7.163 6.058 6.058 0 00.52 4.99 6.11 6.11 0 006.59 2.934A6.058 6.058 0 0013.158 24a6.11 6.11 0 005.826-4.206 6.058 6.058 0 004.048-2.932 6.11 6.11 0 00-.75-7.04z" fill="#10a37f"/>
    </svg>
  );
}

/** Sidebar toggle icon (VS Code style) */
export function SidebarIcon(props: { isOpen: boolean; size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="14" height="14" rx="1" stroke="currentColor" stroke-width="1.2" fill="none"/>
      <line x1="5.5" y1="1" x2="5.5" y2="15" stroke="currentColor" stroke-width="1.2"/>
      {props.isOpen && <>
        <line x1="3" y1="5" x2="3" y2="5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="3" y1="8" x2="3" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        <line x1="3" y1="11" x2="3" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </>}
    </svg>
  );
}

/** Refresh/reload icon */
export function RefreshIcon(props: { size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path d="M13.5 8a5.5 5.5 0 01-10.58 2.12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <path d="M2.5 8a5.5 5.5 0 0110.58-2.12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/>
      <path d="M1 11.5l1.92-1.38L4.5 11.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M15 4.5l-1.92 1.38L11.5 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>
  );
}

/** Git branch icon */
export function BranchIcon(props: { size?: number }) {
  const s = props.size ?? 12;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <path
        d="M5 3.5a1.5 1.5 0 1 1-2 0 1.5 1.5 0 0 1 2 0zM4 6v4.5M4 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM13 5.5a1.5 1.5 0 1 1-2 0 1.5 1.5 0 0 1 2 0zM12 7v.5a3 3 0 0 1-3 3H7"
        stroke="currentColor"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** Terminal icon */
export function TerminalIcon(props: { size?: number }) {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" fill="none"/>
      <path d="M4 6l2.5 2L4 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <line x1="8.5" y1="10" x2="12" y2="10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
  );
}
