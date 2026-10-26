import type { InvestigationRun } from "../src/agents/types.ts";

export const DEFAULT_MAX_RUNS = 100;

/** Small in-memory run store for the demo process. Finite capacity (FIFO eviction). */
export class RunStore {
  private runs = new Map<string, InvestigationRun>();
  private order: string[] = [];

  constructor(private readonly maxEntries = DEFAULT_MAX_RUNS) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive safe integer");
    }
  }

  get size(): number {
    return this.runs.size;
  }

  get max(): number {
    return this.maxEntries;
  }

  put(run: InvestigationRun): void {
    if (this.runs.has(run.runId)) {
      this.runs.set(run.runId, run);
      return;
    }
    while (this.runs.size >= this.maxEntries && this.order.length) {
      const evict = this.order.shift()!;
      this.runs.delete(evict);
    }
    this.runs.set(run.runId, run);
    this.order.push(run.runId);
  }

  get(runId: string): InvestigationRun | undefined {
    return this.runs.get(runId);
  }

  update(runId: string, next: InvestigationRun): void {
    if (!this.runs.has(runId)) {
      this.put(next);
      return;
    }
    this.runs.set(runId, next);
  }

  listIds(): string[] {
    return [...this.order];
  }
}
