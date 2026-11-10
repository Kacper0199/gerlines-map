import { create } from "zustand";
import { clearTripCache } from "../hooks/use-frame-trip.ts";
import { liveKeyOf } from "../live/train-ids.ts";
import type { LandCode, MapStyleKind } from "../map/style/map-styles.ts";
import { isLandCode, themeForStyle } from "../map/style/map-styles.ts";
import type { GpuTier } from "../map/terrain/gpu-tier.ts";
import { type ColourMode, readColourMode, writeColourMode } from "../modes/colour-mode.ts";
import { type LabelMode, readLabelMode, writeLabelMode } from "../modes/label-mode.ts";
import type { OperatorGroup } from "../modes/operator-groups.ts";
import type { CategoryKey } from "../motion/categories.ts";
import type { DataStatus, LiveSelectionInfo, SelectionStops } from "../motion/protocol.ts";
import type { ProfileHover, ProfileOverlay, Quantile } from "../profile/model.ts";
import type { ProfileView } from "../profile/use-profile.ts";
import type { ThemeName } from "../theme/tokens.ts";

export interface AppState {
  readonly theme: ThemeName;
  readonly mapStyle: MapStyleKind;
  readonly terrain3d: boolean;
  /** What the user or the GPU tier wants of the relief whenever the Terrain style is shown. */
  readonly terrainWanted: boolean;
  readonly buildings: boolean;
  /** A selection tilts the map into 3D (the user's switch). */
  readonly selectionTilt: boolean;
  readonly gpuTier: GpuTier;
  readonly focusLand: LandCode | null;
  readonly selectedId: string | null;
  readonly liveSelection: LiveSelectionInfo | null;
  readonly selectionEnded: boolean;
  readonly following: boolean;
  /** Whether the map draws the selected train: null until the worker says. */
  readonly selectedDrawn: boolean | null;
  readonly routeRequests: number;
  /** Where each stop of the selected train lies on its drawn route, as fractional vertex indices; null until the route arrives. */
  readonly routeStops: SelectionStops | null;
  /** The segment profile the map draws over the selected train's route. */
  readonly profile: ProfileOverlay | null;
  readonly profileHover: ProfileHover | null;
  /** The profile switch and measure of the card, kept here so the map keeps the profile while the phone sheet is folded. */
  readonly profileOn: boolean;
  readonly profileQuantile: Quantile;
  readonly profileView: ProfileView;
  /** Counts the reader's retries after a failed profile; the controller asks again when it grows. */
  readonly profileRetries: number;
  readonly status: DataStatus;
  readonly zoom: number;
  readonly hiddenCategories: readonly CategoryKey[];
  readonly hiddenOperatorGroups: readonly OperatorGroup[];
  readonly colourMode: ColourMode;
  readonly labelMode: LabelMode;
  readonly mapInteracted: boolean;
  setTheme(theme: ThemeName): void;
  setMapStyle(style: MapStyleKind): void;
  setTerrain3d(on: boolean): void;
  setBuildings(on: boolean): void;
  setSelectionTilt(on: boolean): void;
  setFocusLand(code: LandCode | null): void;
  select(id: string | null): void;
  setLiveSelection(info: LiveSelectionInfo | null): void;
  setFollowing(following: boolean): void;
  setSelectedDrawn(drawn: boolean, key: number): void;
  requestRoute(): void;
  setRouteStops(stops: SelectionStops | null): void;
  setProfile(profile: ProfileOverlay | null): void;
  setProfileHover(hover: ProfileHover | null): void;
  setProfileOn(on: boolean): void;
  setProfileQuantile(quantile: Quantile): void;
  setProfileView(view: ProfileView): void;
  retryProfile(): void;
  setStatus(status: DataStatus): void;
  setZoom(zoom: number): void;
  setCategoryVisible(category: CategoryKey, visible: boolean): void;
  setOperatorGroupVisible(group: OperatorGroup, visible: boolean): void;
  setColourMode(mode: ColourMode): void;
  setLabelMode(mode: LabelMode): void;
  markMapInteracted(): void;
}

type StateFields = Omit<
  AppState,
  | "setTheme"
  | "setMapStyle"
  | "setTerrain3d"
  | "setBuildings"
  | "setSelectionTilt"
  | "setFocusLand"
  | "select"
  | "setLiveSelection"
  | "setFollowing"
  | "setSelectedDrawn"
  | "requestRoute"
  | "setRouteStops"
  | "setProfile"
  | "setProfileHover"
  | "setProfileOn"
  | "setProfileQuantile"
  | "setProfileView"
  | "retryProfile"
  | "setStatus"
  | "setZoom"
  | "setCategoryVisible"
  | "setOperatorGroupVisible"
  | "setColourMode"
  | "setLabelMode"
  | "markMapInteracted"
>;

const LOADING: DataStatus = {
  state: "loading",
  dataTimeMs: undefined,
  trips: 0,
  realtime: 0,
  untracked: 0,
  counts: { hsr: 0, ld: 0, night: 0, rfast: 0, reg: 0, sbahn: 0, foreign: 0 },
  error: undefined,
};

export function initialState(): StateFields {
  return {
    theme: "dark",
    mapStyle: "dark",
    terrain3d: false,
    terrainWanted: false,
    buildings: false,
    selectionTilt: true,
    gpuTier: "mid",
    focusLand: null,
    selectedId: null,
    liveSelection: null,
    selectionEnded: false,
    following: false,
    selectedDrawn: null,
    routeRequests: 0,
    routeStops: null,
    profile: null,
    profileHover: null,
    profileOn: false,
    profileQuantile: "median",
    profileView: { state: "idle" },
    profileRetries: 0,
    status: LOADING,
    zoom: 5,
    hiddenCategories: [],
    hiddenOperatorGroups: [],
    colourMode: "category",
    labelMode: "off",
    mapInteracted: false,
  };
}

export const useAppStore = create<AppState>()((set, get) => ({
  ...initialState(),
  colourMode: readColourMode(),
  labelMode: readLabelMode(),
  setTheme: (theme) => set({ theme, mapStyle: theme }),
  setMapStyle: (mapStyle) =>
    set({
      mapStyle,
      theme: themeForStyle(mapStyle),
      terrain3d: mapStyle === "terrain" && get().terrainWanted,
    }),
  setTerrain3d: (terrainWanted) =>
    set({ terrainWanted, terrain3d: terrainWanted && get().mapStyle === "terrain" }),
  setBuildings: (buildings) => set({ buildings }),
  setSelectionTilt: (selectionTilt) => set({ selectionTilt }),
  setFocusLand: (focusLand) => {
    if (focusLand === null || isLandCode(focusLand)) {
      set({ focusLand });
    }
  },
  select: (id) =>
    set({
      selectedId: id,
      liveSelection: null,
      selectionEnded: false,
      following: false,
      selectedDrawn: null,
      routeRequests: 0,
      routeStops: null,
      profile: null,
      profileHover: null,
      profileOn: false,
      profileQuantile: "median",
      profileView: { state: "idle" },
      profileRetries: 0,
    }),
  setLiveSelection: (info) => {
    if (get().selectedId === null) {
      return;
    }
    set(
      info
        ? { liveSelection: info, selectionEnded: false }
        : { liveSelection: null, selectionEnded: true },
    );
  },
  setFollowing: (following) => {
    if (get().selectedId === null || get().following === following) {
      return;
    }
    set({ following });
  },
  setSelectedDrawn: (selectedDrawn, key) => {
    if (liveKeyOf(get().selectedId) !== key) {
      return;
    }
    set(selectedDrawn ? { selectedDrawn } : { selectedDrawn, following: false });
  },
  requestRoute: () => {
    if (get().selectedId !== null) {
      set({ routeRequests: get().routeRequests + 1 });
    }
  },
  setRouteStops: (routeStops) => {
    if (get().selectedId !== null || routeStops === null) {
      set({ routeStops });
    }
  },
  setProfile: (profile) => {
    if (get().selectedId !== null || profile === null) {
      set({ profile, ...(profile === null ? { profileHover: null } : {}) });
    }
  },
  setProfileHover: (profileHover) => {
    if (get().profile !== null || profileHover === null) {
      set({ profileHover });
    }
  },
  setProfileOn: (profileOn) => {
    if (get().selectedId !== null || !profileOn) {
      set({ profileOn, ...(profileOn ? {} : { profileView: { state: "idle" } }) });
    }
  },
  setProfileQuantile: (profileQuantile) => set({ profileQuantile }),
  setProfileView: (profileView) => set({ profileView }),
  retryProfile: () => set({ profileRetries: get().profileRetries + 1 }),
  setStatus: (status) => {
    const previous = get().status.timelineEpoch;
    if (
      previous !== undefined &&
      status.timelineEpoch !== undefined &&
      status.timelineEpoch !== previous
    ) {
      clearTripCache();
    }
    set({ status });
  },
  setZoom: (zoom) => set({ zoom }),
  setCategoryVisible: (category, visible) => {
    const hidden = get().hiddenCategories.filter((entry) => entry !== category);
    set({ hiddenCategories: visible ? hidden : [...hidden, category] });
  },
  setOperatorGroupVisible: (group, visible) => {
    const hidden = get().hiddenOperatorGroups.filter((entry) => entry !== group);
    set({ hiddenOperatorGroups: visible ? hidden : [...hidden, group] });
  },
  setColourMode: (colourMode) => {
    if (get().colourMode === colourMode) {
      return;
    }
    writeColourMode(colourMode);
    set({ colourMode });
  },
  setLabelMode: (labelMode) => {
    if (get().labelMode === labelMode) {
      return;
    }
    writeLabelMode(labelMode);
    set({ labelMode });
  },
  markMapInteracted: () => {
    if (!get().mapInteracted) {
      set({ mapInteracted: true });
    }
  },
}));
