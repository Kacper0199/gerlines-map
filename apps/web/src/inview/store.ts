import { create } from "zustand";
import type { NearestTrains } from "../motion/protocol.ts";
import { usePanelStore } from "../state/panel-store.ts";
import type { Place } from "./model.ts";

/** How many trains the list holds. */
export const IN_VIEW_COUNT = 20;

export interface NearestAnswer {
  readonly centre: Place;
  readonly result: NearestTrains;
}

export type NearestRequester = () => Promise<NearestAnswer>;

export interface InViewState {
  /** The newest answer: the trains nearest the middle of the map and the count in view. */
  readonly answer: NearestAnswer | null;
  readonly loading: boolean;
  /** The last request failed (no map, the worker gone): shown as missing, never as an empty list. */
  readonly error: boolean;
  /** Counts the requests to move the focus to the list heading (the skip link). */
  readonly headingFocus: number;
  /** Counts the moves the user made, so the list and the summary follow the map. */
  readonly moves: number;
  attach(requester: NearestRequester | null): void;
  refresh(): Promise<NearestAnswer | null>;
  userMoved(): void;
  requestHeadingFocus(): void;
}

let requester: NearestRequester | null = null;
let generation = 0;

export const useInViewStore = create<InViewState>()((set) => ({
  answer: null,
  loading: false,
  error: false,
  headingFocus: 0,
  moves: 0,
  attach: (next) => {
    requester = next;
    generation += 1;
    if (next === null) set({ answer: null, loading: false, error: false });
  },
  refresh: async () => {
    const asking = requester;
    if (asking === null) return null;
    const mine = ++generation;
    set({ loading: true });
    try {
      const answer = await asking();
      if (mine !== generation) return null;
      set({ answer, loading: false, error: false });
      return answer;
    } catch {
      if (mine === generation) set({ loading: false, error: true });
      return null;
    }
  },
  userMoved: () => set((state) => ({ moves: state.moves + 1 })),
  requestHeadingFocus: () => set((state) => ({ headingFocus: state.headingFocus + 1 })),
}));

export function resetInViewStore(): void {
  requester = null;
  generation += 1;
  useInViewStore.setState({
    answer: null,
    loading: false,
    error: false,
    headingFocus: 0,
    moves: 0,
  });
}

export function openInView(): void {
  usePanelStore.getState().open("inview");
}

export function closeInView(): void {
  usePanelStore.getState().close("inview");
}
