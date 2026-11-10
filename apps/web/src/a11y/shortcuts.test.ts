import { beforeEach, describe, expect, it } from "vitest";
import { createShortcutsStore, initialShortcuts, SHORTCUTS_STORAGE_KEY } from "./shortcuts.ts";

function memory(initial?: string): Storage {
  const values = new Map<string, string>(
    initial === undefined ? [] : [[SHORTCUTS_STORAGE_KEY, initial]],
  );
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  } as Storage;
}

describe("keyboard shortcuts switch", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = memory();
  });

  it("is on until the visitor turns it off", () => {
    expect(initialShortcuts(storage)).toBe(true);
    expect(initialShortcuts(memory("on"))).toBe(true);
    expect(initialShortcuts(memory("off"))).toBe(false);
    expect(initialShortcuts(memory("garbage"))).toBe(true);
  });

  it("stays on when storage cannot be read", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(initialShortcuts(broken)).toBe(true);
  });

  it("stores the choice like the terrain switch", () => {
    const store = createShortcutsStore(storage);
    expect(store.getState().enabled).toBe(true);
    store.getState().setEnabled(false);
    expect(store.getState().enabled).toBe(false);
    expect(storage.getItem(SHORTCUTS_STORAGE_KEY)).toBe("off");
    store.getState().setEnabled(true);
    expect(storage.getItem(SHORTCUTS_STORAGE_KEY)).toBe("on");
  });

  it("starts from what was stored", () => {
    expect(createShortcutsStore(memory("off")).getState().enabled).toBe(false);
  });
});
