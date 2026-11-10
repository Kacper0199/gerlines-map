import { useA11yCopy } from "@gerlines/i18n/a11y";
import { useCopy } from "@gerlines/i18n/react";
import { useSignatureCopy } from "@gerlines/i18n/signature";
import { cn, StyleThumb, Switch } from "@gerlines/ui";
import { ChevronDown } from "lucide-react";
import { useId } from "react";
import { useShortcutsStore } from "../../a11y/shortcuts.ts";
import { MAP_STYLES, type MapStyleKind } from "../../map/style/map-styles.ts";
import {
  BUILDINGS_STORAGE_KEY,
  storeToggle,
  TERRAIN_STORAGE_KEY,
} from "../../map/terrain/policy.ts";
import { storeSelectionTilt } from "../../signature/tilt-policy.ts";
import { useAppStore } from "../../state/store.ts";
import { storeMapStyle } from "../../theme/preference.ts";

export const FOLD_TRIGGER_CLASS =
  "focus-ring type-label flex min-h-target w-full items-center justify-between gap-2 px-4 focus-visible:outline-offset-[-2px]!";

/** The words of the folded style row: the label and the chosen style with a chevron that turns when the popover is open. */
export function FoldLabel({ open }: { open: boolean }) {
  const { style: copy } = useCopy();
  const mapStyle = useAppStore((state) => state.mapStyle);
  return (
    <>
      <span>{copy.label}</span>
      <span className="flex items-center gap-2 text-ink-muted">
        {copy[mapStyle]}
        <ChevronDown
          aria-hidden="true"
          className="size-[18px] shrink-0 transition-transform data-[open=true]:rotate-180"
          data-open={open}
        />
      </span>
    </>
  );
}

function chooseTerrain3d(on: boolean): void {
  useAppStore.getState().setTerrain3d(on);
  storeToggle(window.localStorage, TERRAIN_STORAGE_KEY, on);
}

function chooseBuildings(on: boolean): void {
  useAppStore.getState().setBuildings(on);
  storeToggle(window.localStorage, BUILDINGS_STORAGE_KEY, on);
}

function chooseSelectionTilt(on: boolean): void {
  useAppStore.getState().setSelectionTilt(on);
  storeSelectionTilt(window.localStorage, on);
}

function chooseStyle(style: MapStyleKind): void {
  useAppStore.getState().setMapStyle(style);
  storeMapStyle(window.localStorage, style);
}

export function StyleThumbs({ wide }: { wide: boolean }) {
  const { style: copy } = useCopy();
  const mapStyle = useAppStore((state) => state.mapStyle);
  return (
    <div
      className={cn(
        "grid gap-x-2 gap-y-1 px-3",
        wide ? "grid-cols-[repeat(4,minmax(0,1fr))]" : "grid-cols-2",
      )}
    >
      {MAP_STYLES.map((kind) => (
        <StyleThumb
          key={kind}
          kind={kind}
          label={copy[kind]}
          pressed={mapStyle === kind}
          onPress={() => chooseStyle(kind)}
        />
      ))}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const hintId = useId();
  return (
    <div className="flex min-h-target items-center justify-between gap-3 px-3">
      <label htmlFor={id} className="type-label text-ink">
        {label}
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        {...(hint ? { "aria-describedby": hintId } : {})}
      />
      {hint ? (
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function StyleSwitches() {
  const { style: copy, terrain: terrainCopy } = useCopy();
  const { tilt: tiltLabel } = useSignatureCopy();
  const mapStyle = useAppStore((state) => state.mapStyle);
  const terrain3d = useAppStore((state) => state.terrain3d);
  const buildings = useAppStore((state) => state.buildings);
  const selectionTilt = useAppStore((state) => state.selectionTilt);
  const gpuTier = useAppStore((state) => state.gpuTier);
  const a11y = useA11yCopy();
  const shortcuts = useShortcutsStore((state) => state.enabled);
  const setShortcuts = useShortcutsStore((state) => state.setEnabled);
  const shortcutsId = useId();
  const terrainId = useId();
  const buildingsId = useId();
  const tiltId = useId();
  return (
    <>
      {mapStyle === "terrain" ? (
        <SwitchRow
          id={terrainId}
          label={copy.terrain3d}
          checked={terrain3d}
          onChange={chooseTerrain3d}
        />
      ) : null}
      {terrain3d ? (
        <SwitchRow
          id={buildingsId}
          label={terrainCopy.buildings}
          checked={buildings}
          onChange={chooseBuildings}
        />
      ) : null}
      <SwitchRow
        id={shortcutsId}
        label={a11y.shortcuts}
        hint={a11y.shortcutsHint}
        checked={shortcuts}
        onChange={setShortcuts}
      />
      <SwitchRow
        id={tiltId}
        label={tiltLabel}
        checked={selectionTilt}
        onChange={chooseSelectionTilt}
      />
      {gpuTier === "low" && terrain3d ? (
        <p className="type-label px-3 text-ink-muted">{terrainCopy.slowHint}</p>
      ) : null}
    </>
  );
}
