export interface SessionHealthResult {
  zombieCount: number;
  isActiveStale: boolean;
}

export function analyzeSessionHealth(
  backendIds: string[],
  frontendIds: string[],
  activePtyId: string | null,
): SessionHealthResult {
  const alive = new Set(backendIds);
  const kept = new Set(frontendIds);
  const zombieCount = backendIds.filter(id => !kept.has(id)).length;
  const isActiveStale = activePtyId !== null && !alive.has(activePtyId);
  return { zombieCount, isActiveStale };
}
