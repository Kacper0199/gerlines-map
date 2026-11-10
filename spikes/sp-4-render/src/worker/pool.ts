import type { ChannelKind, ChannelPayload, RecycledChannel } from "../protocol.ts";
import type { Allocator } from "../scene.ts";

const BYTES: Record<ChannelKind, number> = { f64: 8, f32: 4, u8: 1, u32: 4 };
const GROWTH = 1.25;

export class ChannelPool implements Allocator {
  private readonly free = new Map<string, ArrayBuffer[]>();
  private readonly issued: ChannelPayload[] = [];
  private prefix = "";

  begin(prefix: string): void {
    this.prefix = prefix;
  }

  take(): ChannelPayload[] {
    return this.issued.splice(0, this.issued.length);
  }

  recycle(returned: readonly RecycledChannel[]): void {
    for (const { key, buffer } of returned) {
      const list = this.free.get(key) ?? [];
      list.push(buffer);
      this.free.set(key, list);
    }
  }

  private acquire(name: string, kind: ChannelKind, length: number): ArrayBuffer {
    const key = `${this.prefix}:${name}`;
    const need = length * BYTES[kind];
    const list = this.free.get(key);
    let buffer: ArrayBuffer | undefined;
    if (list) {
      const index = list.findIndex((candidate) => candidate.byteLength >= need);
      if (index !== -1) buffer = list.splice(index, 1)[0];
    }
    buffer ??= new ArrayBuffer(Math.max(8, Math.ceil(need * GROWTH)));
    this.issued.push({ key, kind, buffer, length });
    return buffer;
  }

  f64(name: string, length: number): Float64Array {
    return new Float64Array(this.acquire(name, "f64", length), 0, length);
  }

  f32(name: string, length: number): Float32Array {
    return new Float32Array(this.acquire(name, "f32", length), 0, length);
  }

  u8(name: string, length: number): Uint8Array {
    return new Uint8Array(this.acquire(name, "u8", length), 0, length);
  }

  u32(name: string, length: number): Uint32Array {
    return new Uint32Array(this.acquire(name, "u32", length), 0, length);
  }
}
