export function countZombies(backendIds: string[], frontendIds: string[]): number {
  const kept = new Set(frontendIds);
  return backendIds.filter(id => !kept.has(id)).length;
}
