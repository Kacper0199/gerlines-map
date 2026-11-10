interface Slot {
  start: number;
  capacity: number;
}

/** Room a mesh gets for a count: the count and half as much again, at least four more. */
export function capacityFor(count: number): number {
  return count + Math.max(4, Math.ceil(count * 0.5));
}

/** The arrays may hold twice the packed size of the frame, plus this, before the slots are packed again. */
export const SLACK_FLOOR = 128;

/**
 * Where each mesh's instances sit in the fleet's arrays. A mesh keeps its slot while its count fits,
 * so the models that read the arrays by offset keep their buffer layouts (luma builds a new render
 * pipeline for every new layout, which costs several milliseconds on a phone). A mesh that is new or
 * outgrew its room gets a slot after all the others and moves nothing else, with room for twice its
 * old room, so a mesh that grows while the camera zooms moves a few times and not at every step. Only when the arrays hold more than twice the size the current frame
 * would take packed (plus a small floor) are all slots packed again, once.
 */
export class SlotLayout {
  private readonly slots = new Map<string, Slot>();
  private end = 0;

  /** Starts of the given meshes (in the order given) and the number of instances the arrays must hold. */
  place(wanted: readonly { id: string; count: number }[]): { starts: number[]; total: number } {
    if (wanted.length === 0) {
      this.slots.clear();
      this.end = 0;
      return { starts: [], total: 0 };
    }
    let packed = 0;
    for (const { id, count } of wanted) {
      packed += capacityFor(count);
      const slot = this.slots.get(id);
      if (!slot || count > slot.capacity) this.assign(id, count, slot?.capacity ?? 0);
    }
    if (this.end > 2 * packed + SLACK_FLOOR) this.pack(wanted);
    return {
      starts: wanted.map(({ id }) => (this.slots.get(id) as Slot).start),
      total: this.end,
    };
  }

  private assign(id: string, count: number, outgrown: number): void {
    const capacity = capacityFor(Math.max(count, 2 * outgrown));
    this.slots.set(id, { start: this.end, capacity });
    this.end += capacity;
  }

  private pack(wanted: readonly { id: string; count: number }[]): void {
    this.slots.clear();
    this.end = 0;
    for (const { id, count } of wanted) {
      const capacity = capacityFor(count);
      this.slots.set(id, { start: this.end, capacity });
      this.end += capacity;
    }
  }
}
