/** A pending slash command that was deferred while a turn was streaming. */
export interface PendingSlashCommand {
  readonly id: string;
  readonly silent: boolean;
}

/** Holds at most one queued slash command. Later enqueues replace earlier ones
 *  so an explicit user click always wins over a stale auto-compact request,
 *  and a redundant repeat collapses to a single execution. */
export class SlashCommandQueue {
  private pending: PendingSlashCommand | null = null;

  enqueue(cmd: PendingSlashCommand): void {
    this.pending = cmd;
  }

  /** Atomically remove and return the queued command, if any. */
  drain(): PendingSlashCommand | null {
    const cmd = this.pending;
    this.pending = null;
    return cmd;
  }

  clear(): void {
    this.pending = null;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }
}
