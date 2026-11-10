import { type Head, type HeldPackSet, type PackSetFetch, packSetPlan } from "@gerlines/live-frame";
import type { ShapeStore } from "./shape-store.ts";

export interface PackSetLoaderOptions {
  readonly store: Pick<ShapeStore, "loadSets">;
  /** Bytes of a published object below the live base URL, null for a 404. */
  readonly read: (path: string) => Promise<Uint8Array | null>;
}

export interface PackSetStats {
  readonly held: HeldPackSet | null;
  readonly sets: number;
  readonly shapes: number;
  readonly failures: number;
  /** Parts not read, by why: a decode error code, not_found, timeout, network or unusable. */
  readonly failuresByCode: Readonly<Record<string, number>>;
}

/**
 * Follows the pack sets a head names (FORMAT.md 4.2): the base set on joining, after a gap or an
 * epoch change, then the increments as the windows pass. One plan runs at a time; a set that
 * cannot be read is not asked for again until the head names a newer one, and single packs cover
 * what is missing. A base read in part counts as held: the next window's increment and
 * single packs fill the rest instead of a whole base again.
 */
export class PackSetLoader {
  private readonly options: PackSetLoaderOptions;
  private held: HeldPackSet | null = null;
  private running = false;
  private failedTarget: string | null = null;
  private sets = 0;
  private shapes = 0;
  private failures = 0;
  private readonly failuresByCode: Record<string, number> = {};

  constructor(options: PackSetLoaderOptions) {
    this.options = options;
  }

  /** Starts the plan for this head unless one runs; `frameEpoch` null before the first frame. */
  offer(head: Head, frameEpoch: number | null): void {
    const sets = head.packSets;
    if (this.running || !sets || (frameEpoch !== null && frameEpoch !== sets.epoch)) return;
    const plan = packSetPlan(head, this.held);
    if (!plan) return;
    const target = `${sets.epoch}/${"base" in plan ? plan.base : plan.to}`;
    if (target === this.failedTarget) return;
    this.running = true;
    void this.load(sets.epoch, plan, target).finally(() => {
      this.running = false;
    });
  }

  stats(): PackSetStats {
    return {
      held: this.held,
      sets: this.sets,
      shapes: this.shapes,
      failures: this.failures,
      failuresByCode: { ...this.failuresByCode },
    };
  }

  private async load(epoch: number, plan: NonNullable<PackSetFetch>, target: string) {
    const base = "base" in plan;
    const paths = base
      ? Array.from({ length: plan.parts }, (_, k) => [plan.base, `b/${plan.base}/${k}`] as const)
      : Array.from({ length: plan.to - plan.from + 1 }, (_, k) => {
          const id = plan.from + k;
          return [id, `i/${id}`] as const;
        });
    const { added, read, failure } = await this.options.store.loadSets(
      epoch,
      paths.map(
        ([, path]) =>
          () =>
            this.options.read(`sets/${epoch}/${path}.bin`),
      ),
      { base },
    );
    this.shapes += added;
    this.sets += read;
    const last = base ? (read > 0 ? plan.base : null) : (paths[read - 1]?.[0] ?? null);
    if (last !== null) this.held = { epoch, id: last };
    if (failure !== null) {
      this.failures++;
      this.failuresByCode[failure] = (this.failuresByCode[failure] ?? 0) + 1;
      this.failedTarget = target;
    }
  }
}
