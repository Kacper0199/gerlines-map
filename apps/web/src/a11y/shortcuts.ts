import { create, type StoreApi, type UseBoundStore } from "zustand";
import { readToggle, storeToggle } from "../map/terrain/policy.ts";

export const SHORTCUTS_STORAGE_KEY = "gerlines-keyboard-shortcuts";

export interface ShortcutsState {
  /** Whether single key shortcuts (the slash key focuses the search) are active; WCAG 2.1.4 asks for a way to turn them off. */
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
}

export function initialShortcuts(storage: Pick<Storage, "getItem">): boolean {
  return readToggle(storage, SHORTCUTS_STORAGE_KEY) ?? true;
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function createShortcutsStore(
  storage: Storage | undefined = browserStorage(),
): UseBoundStore<StoreApi<ShortcutsState>> {
  return create<ShortcutsState>()((set) => ({
    enabled: storage === undefined ? true : initialShortcuts(storage),
    setEnabled: (enabled) => {
      set({ enabled });
      if (storage !== undefined) storeToggle(storage, SHORTCUTS_STORAGE_KEY, enabled);
    },
  }));
}

export const useShortcutsStore = createShortcutsStore();
