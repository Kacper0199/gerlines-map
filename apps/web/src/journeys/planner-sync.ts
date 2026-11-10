import type { StoreApi } from "zustand";
import type { PlannerState, PlannerStation } from "./planner-store.ts";
import {
  CLOSED_PLANNER,
  PLANNER_CATEGORIES,
  type PlannerUrl,
  parsePlannerUrl,
  sameSearch,
  writePlannerUrl,
} from "./planner-url.ts";

export interface PlannerSyncEnvironment {
  readonly location: Pick<Location, "pathname" | "search" | "hash">;
  readonly history: Pick<History, "pushState" | "replaceState">;
  addPopListener(listener: () => void): () => void;
  loadStation(id: string): Promise<PlannerStation | null>;
}

/**
 * What the address should hold for this state: the search the results answer and the shown
 * journey, without `plan=1` while another panel holds the slot.
 */
export function addressFor(state: PlannerState): PlannerUrl {
  if (!state.searched) return state.open ? { ...CLOSED_PLANNER, open: true } : CLOSED_PLANNER;
  return { ...state.searched, open: state.open, selected: state.selectedId };
}

function setAsideIn(planner: PlannerUrl): boolean {
  return !planner.open && planner.from !== null && planner.to !== null;
}

function same(a: PlannerUrl, b: PlannerUrl): boolean {
  return sameSearch(a, b) && a.selected === b.selected;
}

function loadEnd(
  environment: PlannerSyncEnvironment,
  id: string | null,
): Promise<PlannerStation | null> {
  return id ? environment.loadStation(id) : Promise.resolve(null);
}

/** Handles an address that needs no new search (closed, or the shown search); true when done. */
function keepsSearch(state: PlannerState, wanted: PlannerUrl): boolean {
  if (!wanted.open) {
    if (!state.open) return true;
    if (setAsideIn(wanted)) state.setAside();
    else state.closePlanner();
    return true;
  }
  if (!(state.searched && sameSearch(state.searched, wanted))) return false;
  if (wanted.selected && wanted.selected !== state.selectedId) state.select(wanted.selected);
  if (!state.open) state.openPlanner();
  return true;
}

function fillForm(store: StoreApi<PlannerState>, wanted: PlannerUrl): void {
  const state = store.getState();
  state.openPlanner();
  state.setTime(wanted.time);
  state.setArriveBy(wanted.arriveBy);
  state.setOperator(wanted.operator ?? "");
  const categories: readonly string[] = wanted.categories ?? PLANNER_CATEGORIES;
  for (const category of PLANNER_CATEGORIES) {
    if (store.getState().categories.includes(category) !== categories.includes(category)) {
      store.getState().toggleCategory(category);
    }
  }
}

/**
 * Keeps the address and the planner in step (History API, D-057): opening, closing and each new
 * search are new history entries, picking another journey replaces the current one. A link or Back
 * and Forward restore the planner: the stations load by their stop place ids, the search runs
 * again and the named journey is shown when the search still finds it.
 */
export function startPlannerSync(
  environment: PlannerSyncEnvironment,
  store: StoreApi<PlannerState>,
): () => void {
  const { location, history } = environment;
  let applying = 0;
  let generation = 0;

  const write = (next: PlannerUrl, mode: "pushState" | "replaceState") => {
    const search = writePlannerUrl(location.search, next);
    if (search === location.search) return;
    history[mode](null, "", `${location.pathname}${search}${location.hash}`);
  };

  const restore = async (wanted: PlannerUrl) => {
    generation += 1;
    const mine = generation;
    applying += 1;
    try {
      fillForm(store, wanted);
      const [from, to] = await Promise.all([
        loadEnd(environment, wanted.from),
        loadEnd(environment, wanted.to),
      ]);
      if (mine !== generation) return;
      store.getState().setFrom(from);
      store.getState().setTo(to);
      if (from && to) await store.getState().search({ select: wanted.selected });
      else store.getState().clearResults();
    } finally {
      applying -= 1;
    }
    const state = store.getState();
    if (mine === generation && state.searched) write(addressFor(state), "replaceState");
  };

  const apply = async () => {
    const wanted = parsePlannerUrl(location.search);
    if (keepsSearch(store.getState(), wanted)) {
      generation += 1;
      return;
    }
    await restore(wanted);
  };

  /** The planner opens on a search the address set aside, as after a reload with statistics shown. */
  const reopensAside = (state: PlannerState, previous: PlannerState): boolean => {
    if (!(state.open && !previous.open && state.searched === null)) return false;
    const aside = parsePlannerUrl(location.search);
    if (!setAsideIn(aside)) return false;
    const wanted = { ...aside, open: true };
    write(wanted, "pushState");
    void restore(wanted);
    return true;
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (applying > 0 || reopensAside(state, previous)) return;
    const next = addressFor(state);
    const before = addressFor(previous);
    if (same(next, before) || same(next, parsePlannerUrl(location.search))) return;
    write(next, sameSearch(next, before) ? "replaceState" : "pushState");
  });
  const removePop = environment.addPopListener(() => void apply());
  void apply();
  return () => {
    generation += 1;
    unsubscribe();
    removePop();
  };
}
