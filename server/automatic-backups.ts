export interface AutomaticBackupCandidate { id: string; due: boolean }

export class AutomaticBackups {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private closed = false;
  private readonly failures = new Map<string, { retryAt: number; message: string }>();
  constructor(private readonly options: {
    candidates: () => Promise<AutomaticBackupCandidate[] | undefined>;
    backup: (id: string) => Promise<boolean>;
    report: (message: string) => void;
    now?: () => number;
    pollMilliseconds?: number;
  }) {}

  get error(): string | null { return [...this.failures.values()].at(-1)?.message ?? null; }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.pollMilliseconds ?? 60_000);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }

  private async run(): Promise<void> {
    try {
      const candidates = await this.options.candidates();
      if (!candidates) return;
      const ids = new Set(candidates.map(candidate => candidate.id));
      for (const id of this.failures.keys()) if (id !== 'scheduler' && !ids.has(id)) this.failures.delete(id);
      this.failures.delete('scheduler');
      for (const candidate of candidates) {
        if (this.closed) return;
        if (!candidate.due) { this.failures.delete(candidate.id); continue; }
        if (this.now() < (this.failures.get(candidate.id)?.retryAt ?? 0)) continue;
        try { if (await this.options.backup(candidate.id)) this.failures.delete(candidate.id); }
        catch (error) { this.failed(candidate.id, error); }
      }
    } catch (error) { this.failed('scheduler', error); }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private failed(id: string, error: unknown): void {
    const message = `Automatic backup failed: ${error instanceof Error ? error.message : 'Unknown failure'}`;
    const previous = this.failures.get(id);
    if (!previous || this.now() >= previous.retryAt || previous.message !== message) this.options.report(message);
    this.failures.set(id, { retryAt: this.now() + 15 * 60_000, message });
  }
}
