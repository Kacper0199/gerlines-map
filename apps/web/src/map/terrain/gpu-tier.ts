export type GpuTier = "low" | "mid" | "high";

export interface GpuSignals {
  readonly webgl2: boolean;
  /** The unmasked renderer string, null where the browser hides it. */
  readonly renderer: string | null;
  readonly mobile: boolean;
  readonly memoryGb: number | null;
  readonly cores: number | null;
}

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/;
const LOW_MEMORY_GB = 2;
const LOW_CORES = 2;
const MOBILE_MEMORY_FOR_MID_GB = 3;

function numberAfter(pattern: RegExp, text: string): number | null {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
}

function phoneTier(renderer: string): GpuTier {
  const adreno = numberAfter(/adreno[^0-9]*(\d{3})/, renderer);
  if (adreno !== null) return adreno >= 650 ? "mid" : "low";
  const mali = numberAfter(/mali-g(\d{2,3})/, renderer);
  if (mali !== null) return mali >= 77 ? "mid" : "low";
  if (/immortalis/.test(renderer)) return "mid";
  if (
    /(powervr|img)[^a-z0-9]*(b-series |c-series |d-series )?(bx|cx|dx)[a-z]?[- ]?\d/.test(renderer)
  ) {
    return "mid";
  }
  const xclipse = numberAfter(/xclipse[^0-9]*(\d{3})/, renderer);
  if (xclipse !== null) return xclipse >= 920 ? "mid" : "low";
  return /apple/.test(renderer) ? "mid" : "low";
}

function desktopTier(renderer: string): GpuTier {
  if (/apple m\d/.test(renderer)) return "high";
  if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b/.test(renderer)) return "high";
  if (/radeon (rx|pro|vega|r9)|amd radeon rx/.test(renderer)) return "high";
  if (/intel.*\barc\b/.test(renderer)) return "high";
  if (/intel.*iris/.test(renderer)) return "mid";
  if (/intel.*(uhd|hd graphics)/.test(renderer)) return "low";
  return "mid";
}

/**
 * How much 3D the device can draw: low turns the relief and the buildings off by default. The
 * renderer string is the main signal; where a browser hides it a desktop counts as mid and a phone
 * as low. Memory and cores can only lower the result.
 */
export function classifyGpu(signals: GpuSignals): GpuTier {
  if (!signals.webgl2) return "low";
  const renderer = (signals.renderer ?? "").toLowerCase();
  if (SOFTWARE.test(renderer)) return "low";
  let tier = signals.mobile ? phoneTier(renderer) : desktopTier(renderer);
  if (signals.memoryGb !== null && signals.memoryGb <= LOW_MEMORY_GB) tier = "low";
  if (signals.cores !== null && signals.cores <= LOW_CORES) tier = "low";
  if (signals.mobile && signals.memoryGb !== null && signals.memoryGb < MOBILE_MEMORY_FOR_MID_GB) {
    tier = "low";
  }
  return tier;
}

interface ProbeContext {
  readonly RENDERER?: number;
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
}

export interface GpuEnvironment {
  createCanvas(): { getContext(kind: string): unknown };
  readonly navigator: {
    readonly maxTouchPoints?: number;
    readonly hardwareConcurrency?: number | undefined;
    readonly deviceMemory?: number | undefined;
  };
  readonly matchesCoarsePointer: boolean;
}

const GENERIC_RENDERER = /^(webkit webgl|mozilla)?$/i;

function plainRendererOf(context: ProbeContext): string | null {
  const value = context.getParameter(context.RENDERER ?? 0x1f01);
  return typeof value === "string" && !GENERIC_RENDERER.test(value.trim()) ? value : null;
}

function unmaskedRendererOf(context: ProbeContext): string | null {
  try {
    const info = context.getExtension("WEBGL_debug_renderer_info") as {
      UNMASKED_RENDERER_WEBGL: number;
    } | null;
    const value = info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    return typeof value === "string" && value !== "" ? value : null;
  } catch {
    return null;
  }
}

function releaseOf(context: ProbeContext): void {
  try {
    (context.getExtension("WEBGL_lose_context") as { loseContext(): void } | null)?.loseContext();
  } catch {
    return;
  }
}

/**
 * Reads what classifyGpu needs from a throwaway WebGL 2 context, which it releases at once. The
 * plain renderer string comes first (Safari and Firefox name the GPU there, Firefox warns about the
 * debug extension); Chrome answers a generic name and gives the GPU through the extension.
 */
export function readGpuSignals(env: GpuEnvironment): GpuSignals {
  const { navigator } = env;
  const device = {
    mobile: env.matchesCoarsePointer && (navigator.maxTouchPoints ?? 0) > 0,
    memoryGb: navigator.deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
  };
  let context: ProbeContext | null;
  try {
    context = env.createCanvas().getContext("webgl2") as ProbeContext | null;
  } catch {
    context = null;
  }
  if (!context) return { ...device, webgl2: false, renderer: null };
  try {
    const renderer = plainRendererOf(context) ?? unmaskedRendererOf(context);
    return { ...device, webgl2: true, renderer };
  } finally {
    releaseOf(context);
  }
}

let detected: GpuTier | undefined;
let signals: GpuSignals | undefined;

function deviceSignals(): GpuSignals {
  signals ??= readGpuSignals({
    createCanvas: () => document.createElement("canvas"),
    navigator: navigator as GpuEnvironment["navigator"],
    matchesCoarsePointer: window.matchMedia("(pointer: coarse)").matches,
  });
  return signals;
}

/** Whether this device can make a WebGL 2 context, which the map needs; false where the probe itself fails. */
export function hasWebgl2(): boolean {
  try {
    return deviceSignals().webgl2;
  } catch {
    return false;
  }
}
const TIERS: readonly GpuTier[] = ["low", "mid", "high"];

/** The tier a `?probe` page asks for with `?tier=`, so a test sees the same app on every machine; none without `?probe`. */
export function forcedTier(search: string): GpuTier | undefined {
  const params = new URLSearchParams(search);
  const asked = params.get("tier");
  return params.has("probe") && TIERS.includes(asked as GpuTier) ? (asked as GpuTier) : undefined;
}

/** The tier of this device, probed once. */
export function detectGpuTier(): GpuTier {
  detected ??= forcedTier(window.location.search) ?? classifyGpu(deviceSignals());
  return detected;
}
