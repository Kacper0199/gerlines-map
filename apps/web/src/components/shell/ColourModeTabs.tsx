import { useCopy } from "@gerlines/i18n/react";
import { isColourMode } from "../../modes/colour-mode.ts";
import { useAppStore } from "../../state/store.ts";
import { RadioTabs } from "./RadioTabs.tsx";

export function ColourModeTabs() {
  const { mode } = useCopy();
  const colourMode = useAppStore((state) => state.colourMode);
  const setColourMode = useAppStore((state) => state.setColourMode);
  return (
    <RadioTabs
      label={mode.label}
      value={colourMode}
      onValueChange={(value) => {
        if (isColourMode(value)) setColourMode(value);
      }}
      options={[
        { value: "category", label: mode.category },
        { value: "delay", label: mode.delay },
        { value: "operator", label: mode.operator },
      ]}
    />
  );
}
