import { JOURNEY_RELIABILITY_TRAINS_MAX } from "@gerlines/schema/constants";
import type { Journey, JourneysResponse, TrainReliability } from "@gerlines/schema/journeys";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FetchLike } from "../search/search-client.ts";
import { type PanelState, usePanelStore } from "../state/panel-store.ts";
import { berlinInstantOf } from "./berlin-time.ts";
import { mergeJourneys, type ReliabilityEntry, transitLegs } from "./journey-view.ts";
import {
  fetchJourneys,
  fetchReliability,
  type JourneyError,
  type JourneySearch,
  type ReliabilityFetch,
  reliabilityKeyOf,
} from "./journeys-client.ts";
import {
  CLOSED_PLANNER,
  PLANNER_CATEGORIES,
  type PlannerCategory,
  type PlannerUrl,
} from "./planner-url.ts";

/** Height of the phone sheet while it shows the chosen journey; the camera keeps the route above it. */
export const PLANNER_SHEET_PEEK = 196;

export interface PlannerStation {
  readonly id: string;
  readonly name: string;
  /** The stop id journeys take: the DHID, else the station's own DELFI feed id. */
  readonly stopId: string | null;
  readonly lon: number;
  readonly lat: number;
}

export type FormProblem = "stations" | "same" | "noStopId" | "categories";

export type ResultsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly error: JourneyError }
  | {
      readonly status: "ready";
      readonly journeys: readonly Journey[];
      readonly earlierCursor: string | null;
      readonly laterCursor: string | null;
      readonly removed: number;
      readonly partial: boolean;
      readonly paging: "earlier" | "later" | null;
      readonly pageError: JourneyError | null;
    };

export interface PlannerState {
  /** The planner holds the shared slot, or waits in it while a train or station card is shown. */
  readonly open: boolean;
  readonly from: PlannerStation | null;
  readonly to: PlannerStation | null;
  /** Berlin wall clock `YYYY-MM-DDTHH:mm`; null means now. */
  readonly time: string | null;
  readonly arriveBy: boolean;
  readonly categories: readonly PlannerCategory[];
  readonly operator: string;
  readonly problem: FormProblem | null;
  readonly results: ResultsState;
  /** The search the results answer, as the address writes it. */
  readonly searched: PlannerUrl | null;
  readonly selectedId: string | null;
  readonly reliability: ReadonlyMap<string, ReliabilityEntry>;
  openPlanner(): void;
  /** Closes the planner for good: the results and the search they answer go, the form stays. */
  closePlanner(): void;
  /** Leaves the slot but keeps the search and its results, as when another panel takes the slot. */
  setAside(): void;
  setFrom(station: PlannerStation | null): void;
  setTo(station: PlannerStation | null): void;
  swap(): void;
  setTime(time: string | null): void;
  setArriveBy(arriveBy: boolean): void;
  toggleCategory(category: PlannerCategory): void;
  setOperator(operator: string): void;
  search(options?: { readonly select?: string | null }): Promise<void>;
  page(direction: "earlier" | "later"): Promise<void>;
  /** Every kind of train and any operator, then the search again. */
  widen(): Promise<void>;
  select(id: string | null): void;
  /** Drops the results and the search they answer; the form stays. */
  clearResults(): void;
  reset(): void;
}

export interface PlannerDependencies {
  readonly fetch: FetchLike;
  readonly panel: StoreApi<PanelState>;
}

/** Whether the planner holds the shared slot or waits for a card to close. */
export function plannerHeld(slot: Pick<PanelState, "active" | "returnTo">): boolean {
  return slot.active === "journeys" || slot.returnTo === "journeys";
}

const IDLE: ResultsState = { status: "idle" };

const INITIAL = {
  open: false,
  from: null,
  to: null,
  time: null,
  arriveBy: false,
  categories: [...PLANNER_CATEGORIES],
  operator: "",
  problem: null,
  results: IDLE,
  searched: null,
  selectedId: null,
  reliability: new Map<string, ReliabilityEntry>(),
} as const;

function problemOf(state: PlannerState): FormProblem | null {
  if (!(state.from && state.to)) return "stations";
  if (state.from.id === state.to.id) return "same";
  if (!(state.from.stopId && state.to.stopId)) return "noStopId";
  if (state.categories.length === 0) return "categories";
  return null;
}

function chosenCategories(categories: readonly PlannerCategory[]): PlannerCategory[] | null {
  const ordered = PLANNER_CATEGORIES.filter((category) => categories.includes(category));
  return ordered.length === PLANNER_CATEGORIES.length ? null : ordered;
}

function addressOf(state: PlannerState): PlannerUrl {
  const operator = state.operator.trim();
  return {
    ...CLOSED_PLANNER,
    open: true,
    from: state.from?.id ?? null,
    to: state.to?.id ?? null,
    time: state.time,
    arriveBy: state.arriveBy,
    categories: chosenCategories(state.categories),
    operator: operator === "" ? null : operator,
  };
}

function searchOf(state: PlannerState, cursor?: string): JourneySearch {
  const instant = state.time === null ? null : berlinInstantOf(state.time);
  const address = addressOf(state);
  return {
    from: state.from?.stopId ?? "",
    to: state.to?.stopId ?? "",
    time: instant === null ? null : new Date(instant).toISOString(),
    arriveBy: state.arriveBy,
    categories: address.categories,
    operator: address.operator,
    cursor,
  };
}

function unavailableEntry(key: string): TrainReliability {
  const [category, number, ...operator] = key.split("~");
  return {
    status: "missing",
    category: category as TrainReliability["category"],
    number: number as string,
    operator: operator.length > 0 ? operator.join("~") : null,
    reason: "unavailable",
  };
}

/** A train is asked for when nothing is held or the last answer was only a passing failure. */
function needsReliability(entry: ReliabilityEntry | undefined): boolean {
  return entry === undefined || (entry.status === "missing" && entry.reason === "unavailable");
}

type ReadyResults = Extract<ResultsState, { status: "ready" }>;

/** The shown results with an earlier or later page added; only that side's cursor moves. */
function withPage(
  current: ReadyResults,
  direction: "earlier" | "later",
  response: JourneysResponse,
): ReadyResults {
  return {
    ...current,
    journeys: mergeJourneys(current.journeys, response.journeys),
    earlierCursor: direction === "earlier" ? response.earlierCursor : current.earlierCursor,
    laterCursor: direction === "later" ? response.laterCursor : current.laterCursor,
    removed: current.removed + response.removedByFilter,
    partial: current.partial || response.partial,
    paging: null,
    pageError: null,
  };
}

function pageCursor(results: ResultsState, direction: "earlier" | "later"): string | null {
  if (results.status !== "ready" || results.paging) return null;
  return direction === "earlier" ? results.earlierCursor : results.laterCursor;
}

/** The planner's state and its requests; the newest search wins over answers to older ones. */
export function createPlannerStore({
  fetch,
  panel,
}: PlannerDependencies): UseBoundStore<StoreApi<PlannerState>> {
  let generation = 0;
  let lastSearch: PlannerState | null = null;
  let settingAside = false;

  const store = create<PlannerState>()((set, get) => {
    const writeReliability = (keys: readonly string[], answer: ReliabilityFetch) => {
      const next = new Map(get().reliability);
      keys.forEach((key, index) => {
        const train = answer.kind === "ok" ? answer.response.trains[index] : undefined;
        next.set(key, train ?? unavailableEntry(key));
      });
      set({ reliability: next });
    };

    /** Punctuality is keyed by train, so an answer is kept even after a newer search started. */
    const loadReliability = async (journeys: readonly Journey[]) => {
      const known = get().reliability;
      const keys = [
        ...new Set(
          journeys
            .flatMap(transitLegs)
            .map(reliabilityKeyOf)
            .filter((key): key is string => key !== null && needsReliability(known.get(key))),
        ),
      ];
      if (keys.length === 0) return;
      const loading = new Map(known);
      for (const key of keys) loading.set(key, { status: "loading" });
      set({ reliability: loading });
      for (let start = 0; start < keys.length; start += JOURNEY_RELIABILITY_TRAINS_MAX) {
        const group = keys.slice(start, start + JOURNEY_RELIABILITY_TRAINS_MAX);
        writeReliability(group, await fetchReliability(group, { fetch }));
      }
    };

    return {
      ...INITIAL,
      openPlanner: () => {
        if (!plannerHeld(panel.getState())) panel.getState().open("journeys");
      },
      closePlanner: () => panel.getState().close("journeys"),
      setAside: () => {
        settingAside = true;
        try {
          panel.getState().close("journeys");
        } finally {
          settingAside = false;
        }
      },
      setFrom: (from) => set({ from, problem: null }),
      setTo: (to) => set({ to, problem: null }),
      swap: () => set((state) => ({ from: state.to, to: state.from, problem: null })),
      setTime: (time) => set({ time }),
      setArriveBy: (arriveBy) => set({ arriveBy }),
      toggleCategory: (category) =>
        set((state) => ({
          problem: null,
          categories: state.categories.includes(category)
            ? state.categories.filter((item) => item !== category)
            : PLANNER_CATEGORIES.filter(
                (item) => item === category || state.categories.includes(item),
              ),
        })),
      setOperator: (operator) => set({ operator }),

      async search({ select = null } = {}) {
        const state = get();
        const problem = problemOf(state);
        if (problem) {
          set({ problem });
          return;
        }
        generation += 1;
        const mine = generation;
        lastSearch = state;
        set({
          problem: null,
          results: { status: "loading" },
          searched: addressOf(state),
          selectedId: null,
        });
        const answer = await fetchJourneys(searchOf(state), { fetch });
        if (mine !== generation) return;
        if (answer.kind === "error") {
          set({ results: { status: "error", error: answer.error } });
          return;
        }
        const { response } = answer;
        const journeys = mergeJourneys([], response.journeys);
        const wanted = select && journeys.some((journey) => journey.id === select) ? select : null;
        set({
          results: {
            status: "ready",
            journeys,
            earlierCursor: response.earlierCursor,
            laterCursor: response.laterCursor,
            removed: response.removedByFilter,
            partial: response.partial,
            paging: null,
            pageError: null,
          },
          selectedId: wanted ?? journeys[0]?.id ?? null,
        });
        await loadReliability(journeys);
      },

      async page(direction) {
        const results = get().results;
        const cursor = pageCursor(results, direction);
        if (!(cursor && lastSearch) || results.status !== "ready") return;
        const mine = generation;
        set({ results: { ...results, paging: direction, pageError: null } });
        const answer = await fetchJourneys(searchOf(lastSearch, cursor), { fetch });
        const current = get().results;
        if (mine !== generation || current.status !== "ready") return;
        if (answer.kind === "error") {
          set({ results: { ...current, paging: null, pageError: answer.error } });
          return;
        }
        const { response } = answer;
        set({ results: withPage(current, direction, response) });
        await loadReliability(response.journeys);
      },

      widen() {
        set({ categories: [...PLANNER_CATEGORIES], operator: "" });
        return get().search();
      },

      select: (selectedId) => set({ selectedId }),
      clearResults: () => {
        generation += 1;
        lastSearch = null;
        set({ results: IDLE, searched: null, selectedId: null, problem: null });
      },
      reset: () => {
        generation += 1;
        lastSearch = null;
        panel.getState().close("journeys");
        set({ ...INITIAL, reliability: new Map() });
      },
    };
  });

  /** Another panel in the slot sets the planner aside with its search; an empty slot closes it. */
  const follow = (slot: PanelState) => {
    const held = plannerHeld(slot);
    if (held === store.getState().open) return;
    if (held || settingAside || slot.active !== null) {
      store.setState({ open: held });
      return;
    }
    generation += 1;
    store.setState({ open: false, selectedId: null, results: IDLE, searched: null, problem: null });
  };
  panel.subscribe(follow);
  follow(panel.getState());
  return store;
}

const browserFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export const usePlannerStore = createPlannerStore({ fetch: browserFetch, panel: usePanelStore });

export function selectedJourney(state: PlannerState): Journey | null {
  if (state.results.status !== "ready" || state.selectedId === null) return null;
  return state.results.journeys.find((journey) => journey.id === state.selectedId) ?? null;
}
