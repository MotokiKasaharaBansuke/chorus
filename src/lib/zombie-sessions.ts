export function isSessionStale(backendIds: string[], ptyId: string): boolean {
  return !backendIds.includes(ptyId);
}
