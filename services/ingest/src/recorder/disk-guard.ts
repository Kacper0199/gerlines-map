import { statfs } from "node:fs/promises";

export type FreeBytes = (path: string) => Promise<number>;

/**
 * Block counts are in fragment-size units; Docker Desktop bind mounts (virtiofs) report a 1 MiB
 * `bsize` next to a 4 KiB `frsize`, so multiplying by `bsize` overstates free space 256 times.
 */
export function availableBytes(stats: { bavail: number; bsize: number; frsize?: number }): number {
  const unit = stats.frsize && stats.frsize > 0 ? stats.frsize : stats.bsize;
  return stats.bavail * unit;
}

export const statfsFreeBytes: FreeBytes = async (path) => availableBytes(await statfs(path));

export interface DiskTransition {
  readonly paused: boolean;
  readonly freeBytes: number;
}

/** Pauses recording while free space is below the floor; reports only changes. */
export class DiskGuard {
  readonly floorBytes: number;
  private readonly path: string;
  private readonly freeBytes: FreeBytes;
  private state: boolean | null = null;
  lastFreeBytes: number | null = null;

  constructor(path: string, floorBytes: number, freeBytes: FreeBytes = statfsFreeBytes) {
    this.path = path;
    this.floorBytes = floorBytes;
    this.freeBytes = freeBytes;
  }

  get paused(): boolean {
    return this.state === true;
  }

  async check(): Promise<DiskTransition | null> {
    const free = await this.freeBytes(this.path);
    this.lastFreeBytes = free;
    const paused = free < this.floorBytes;
    const changed = this.state !== paused;
    this.state = paused;
    return changed ? { paused, freeBytes: free } : null;
  }
}
