import { create, type StoreApi, type UseBoundStore } from "zustand";

/** The panels that take the card slot of the shell; one holds it at a time. */
export type PanelId = "stats" | "journeys" | "inview";

export interface PanelState {
  /** The panel in the slot, null while the slot is empty or a train or station card holds it. */
  readonly active: PanelId | null;
  /** The panel a train or station card pushed out of the slot, back when that card closes. */
  readonly returnTo: PanelId | null;
  /** True while the panel in the slot came back after a card closed, so it must not take the focus from the map. */
  readonly resumed: boolean;
  /** Opens `id` and closes whichever panel held the slot. */
  open(id: PanelId): void;
  /** Closes `id` if it holds the slot; a panel never closes its successor. */
  close(id: PanelId): void;
  /** A card takes the slot: the open panel waits in `returnTo`. */
  suspend(): void;
  /** The card closed: the panel that waited comes back. */
  resume(): void;
}

export function createPanelStore(): UseBoundStore<StoreApi<PanelState>> {
  return create<PanelState>()((set, get) => ({
    active: null,
    returnTo: null,
    resumed: false,
    open: (id) => {
      const { active, returnTo, resumed } = get();
      if (active !== id || returnTo !== null || resumed) {
        set({ active: id, returnTo: null, resumed: false });
      }
    },
    close: (id) => {
      const { active, returnTo } = get();
      if (active === id) set({ active: null, resumed: false });
      else if (returnTo === id) set({ returnTo: null });
    },
    suspend: () => {
      const { active } = get();
      if (active !== null) set({ active: null, returnTo: active, resumed: false });
    },
    resume: () => {
      const { returnTo } = get();
      if (returnTo !== null) set({ active: returnTo, returnTo: null, resumed: true });
    },
  }));
}

export const usePanelStore = createPanelStore();

export function usePanelOpen(id: PanelId): boolean {
  return usePanelStore((state) => state.active === id);
}

export function resetPanelStore(): void {
  usePanelStore.setState({ active: null, returnTo: null, resumed: false });
}
