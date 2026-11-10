import { useEffect } from "react";
import { usePanelStore } from "./panel-store.ts";
import { usePlaceStore } from "./place-store.ts";
import { useAppStore } from "./store.ts";

function cardOpen(): boolean {
  return useAppStore.getState().selectedId !== null || usePlaceStore.getState().station !== null;
}

/** True while a train card, a station card or a panel holds the left card slot of the desktop shell. */
export function leftSlotOpen(): boolean {
  return (
    cardOpen() ||
    usePlaceStore.getState().missingStation !== null ||
    usePanelStore.getState().active !== null
  );
}

/** True while only a panel holds the left slot, so no card is about to move the camera itself. */
export function panelHoldsLeftSlot(): boolean {
  return (
    usePanelStore.getState().active !== null &&
    !cardOpen() &&
    usePlaceStore.getState().missingStation === null
  );
}

/** Calls `onChange` with the new state whenever the left slot opens or closes, from any store. */
export function watchLeftSlot(onChange: (open: boolean, panelOnly: boolean) => void): () => void {
  let open = leftSlotOpen();
  const settle = () => {
    const now = leftSlotOpen();
    if (now === open) return;
    open = now;
    onChange(now, panelHoldsLeftSlot());
  };
  const stops = [
    useAppStore.subscribe(settle),
    usePlaceStore.subscribe(settle),
    usePanelStore.subscribe(settle),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * A train or station picked on the map takes the slot first: the open panel steps aside, and
 * closing the card brings it back. Mounted once by the shell.
 */
export function usePanelCardSwitch(): void {
  useEffect(() => {
    let open = cardOpen();
    const settle = () => {
      const now = cardOpen();
      if (now === open) return;
      open = now;
      if (now) usePanelStore.getState().suspend();
      else usePanelStore.getState().resume();
    };
    const stopApp = useAppStore.subscribe(settle);
    const stopPlace = usePlaceStore.subscribe(settle);
    return () => {
      stopApp();
      stopPlace();
    };
  }, []);
}
