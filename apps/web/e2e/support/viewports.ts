export interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly touch: boolean;
  /** The spec files this viewport runs: the flows run on one desktop, the select flow on all five. */
  readonly specs: readonly string[];
}

const FLOWS = ["deep-link", "journeys", "modes", "terrain"];

export const VIEWPORTS: readonly Viewport[] = [
  { name: "phone", width: 390, height: 844, touch: true, specs: ["select", "shell", "visual"] },
  { name: "tablet-portrait", width: 834, height: 1194, touch: true, specs: ["select", "visual"] },
  { name: "tablet-landscape", width: 1194, height: 834, touch: true, specs: ["select"] },
  {
    name: "desktop",
    width: 1440,
    height: 900,
    touch: false,
    specs: ["select", "shell", "visual", ...FLOWS],
  },
  { name: "large", width: 2560, height: 1440, touch: false, specs: ["select"] },
];
