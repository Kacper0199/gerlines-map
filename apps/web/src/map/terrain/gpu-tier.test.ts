import { describe, expect, it } from "vitest";
import { classifyGpu, forcedTier, type GpuSignals, hasWebgl2, readGpuSignals } from "./gpu-tier.ts";

const DESKTOP: GpuSignals = {
  webgl2: true,
  renderer: null,
  mobile: false,
  memoryGb: null,
  cores: 8,
};

const tierOf = (overrides: Partial<GpuSignals>) => classifyGpu({ ...DESKTOP, ...overrides });

describe("classifyGpu on a desktop", () => {
  it.each([
    ["ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)", "high"],
    ["ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"],
    ["ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)", "high"],
    ["ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11, D3D11)", "high"],
    ["ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", "mid"],
    ["Mesa Intel(R) Iris(R) Plus Graphics (ICL GT2)", "mid"],
    ["ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)", "low"],
    ["Intel(R) HD Graphics 4000", "low"],
    ["Apple GPU", "mid"],
  ] as const)("calls %s %s", (renderer, tier) => {
    expect(tierOf({ renderer })).toBe(tier);
  });

  it("calls a hidden renderer mid, since nothing says it is weak", () => {
    expect(tierOf({ renderer: null })).toBe("mid");
    expect(tierOf({ renderer: "" })).toBe("mid");
  });

  it("calls software rendering low whatever else it reports", () => {
    expect(tierOf({ renderer: "Google SwiftShader" })).toBe("low");
    expect(tierOf({ renderer: "llvmpipe (LLVM 15.0.7, 256 bits)" })).toBe("low");
    expect(tierOf({ renderer: "Microsoft Basic Render Driver" })).toBe("low");
    expect(
      tierOf({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader)" }),
    ).toBe("low");
  });

  it("calls a browser without WebGL 2 low", () => {
    expect(tierOf({ webgl2: false, renderer: "NVIDIA GeForce RTX 3060" })).toBe("low");
  });

  it("keeps a strong GPU low on a machine with little memory or two cores", () => {
    expect(tierOf({ renderer: "NVIDIA GeForce RTX 3060", memoryGb: 2 })).toBe("low");
    expect(tierOf({ renderer: "NVIDIA GeForce RTX 3060", cores: 2 })).toBe("low");
    expect(tierOf({ renderer: "NVIDIA GeForce RTX 3060", memoryGb: 8, cores: 8 })).toBe("high");
  });
});

describe("classifyGpu on a phone", () => {
  const phone = (renderer: string | null, extra: Partial<GpuSignals> = {}) =>
    classifyGpu({ ...DESKTOP, mobile: true, cores: 8, renderer, ...extra });

  it.each([
    ["Adreno (TM) 740", "mid"],
    ["Adreno (TM) 650", "mid"],
    ["Adreno (TM) 619", "low"],
    ["Adreno (TM) 506", "low"],
    ["Mali-G710 MC10", "mid"],
    ["Mali-G78", "mid"],
    ["Mali-G52 MC2", "low"],
    ["Mali-T860", "low"],
    ["Apple GPU", "mid"],
    ["PowerVR Rogue GE8320", "low"],
    ["PowerVR Rogue GM9446", "low"],
    ["PowerVR B-Series BXM-8-256", "mid"],
    ["PowerVR C-Series CXT-48-1536", "mid"],
    ["IMG DXT-72-1152", "mid"],
    ["Immortalis-G715 MC10", "mid"],
    ["Samsung Xclipse 940", "mid"],
    ["Samsung Xclipse 920", "mid"],
    ["Xclipse 540", "low"],
  ] as const)("calls %s %s", (renderer, tier) => {
    expect(phone(renderer)).toBe(tier);
  });

  it("calls an unknown phone GPU low and never high", () => {
    expect(phone(null)).toBe("low");
    expect(phone("Some New GPU")).toBe("low");
    expect(phone("Apple M2")).toBe("mid");
  });

  it("caps a phone with little memory at low", () => {
    expect(phone("Adreno (TM) 740", { memoryGb: 2 })).toBe("low");
    expect(phone("Adreno (TM) 740", { memoryGb: 8 })).toBe("mid");
  });
});

describe("readGpuSignals", () => {
  const RENDERER = 0x1f01;
  const UNMASKED = 37446;

  function environment(options: {
    renderer?: string;
    plainRenderer?: string;
    webgl2?: boolean;
    touch?: boolean;
    memory?: number;
    cores?: number;
    extensionThrows?: boolean;
  }) {
    const lose = { calls: 0 };
    const asked: string[] = [];
    const context = {
      RENDERER,
      getExtension: (name: string) => {
        asked.push(name);
        if (name === "WEBGL_debug_renderer_info") {
          if (options.extensionThrows) throw new Error("denied");
          return { UNMASKED_RENDERER_WEBGL: UNMASKED };
        }
        if (name === "WEBGL_lose_context") return { loseContext: () => lose.calls++ };
        return null;
      },
      getParameter: (parameter: number) => {
        if (parameter === UNMASKED) return options.renderer ?? null;
        return parameter === RENDERER ? (options.plainRenderer ?? "WebKit WebGL") : null;
      },
    };
    return {
      lose,
      asked,
      env: {
        createCanvas: () => ({
          getContext: (kind: string) =>
            kind === "webgl2" && options.webgl2 !== false ? context : null,
        }),
        navigator: {
          maxTouchPoints: options.touch ? 5 : 0,
          hardwareConcurrency: options.cores,
          deviceMemory: options.memory,
        },
        matchesCoarsePointer: options.touch === true,
      },
    };
  }

  it("reads the unmasked renderer, the device and releases the context", () => {
    const { env, lose } = environment({
      renderer: "Adreno (TM) 740",
      touch: true,
      memory: 8,
      cores: 8,
    });
    expect(readGpuSignals(env)).toEqual({
      webgl2: true,
      renderer: "Adreno (TM) 740",
      mobile: true,
      memoryGb: 8,
      cores: 8,
    });
    expect(lose.calls).toBe(1);
  });

  it("takes the plain renderer when it names the GPU and leaves the debug extension alone", () => {
    const { env, asked } = environment({ plainRenderer: "Apple GPU", renderer: "never read" });
    expect(readGpuSignals(env).renderer).toBe("Apple GPU");
    expect(asked).not.toContain("WEBGL_debug_renderer_info");
  });

  it("asks the debug extension when the plain renderer is generic", () => {
    for (const plainRenderer of ["WebKit WebGL", "Mozilla", ""]) {
      const { env } = environment({ plainRenderer, renderer: "NVIDIA GeForce RTX 3060" });
      expect(readGpuSignals(env).renderer).toBe("NVIDIA GeForce RTX 3060");
    }
  });

  it("reports no WebGL 2 and unknown device numbers as such", () => {
    const { env } = environment({ webgl2: false });
    expect(readGpuSignals(env)).toEqual({
      webgl2: false,
      renderer: null,
      mobile: false,
      memoryGb: null,
      cores: null,
    });
  });

  it("survives a context that cannot be created", () => {
    const env = {
      createCanvas: () => ({
        getContext: () => {
          throw new Error("blocked");
        },
      }),
      navigator: { maxTouchPoints: 0 },
      matchesCoarsePointer: false,
    };
    expect(readGpuSignals(env).webgl2).toBe(false);
  });

  it("keeps WebGL 2 and an unknown renderer when the extension throws, and still releases the context", () => {
    const { env, lose } = environment({ extensionThrows: true, touch: true });
    expect(readGpuSignals(env)).toMatchObject({ webgl2: true, renderer: null, mobile: true });
    expect(lose.calls).toBe(1);
    expect(classifyGpu(readGpuSignals(environment({ extensionThrows: true }).env))).toBe("mid");
  });
});

describe("forcedTier", () => {
  it("takes ?tier= only on a ?probe page and only a known tier", () => {
    expect(forcedTier("?probe=1&tier=mid")).toBe("mid");
    expect(forcedTier("?probe&tier=high")).toBe("high");
    expect(forcedTier("?tier=high")).toBeUndefined();
    expect(forcedTier("?probe&tier=ultra")).toBeUndefined();
    expect(forcedTier("?probe")).toBeUndefined();
  });
});

describe("hasWebgl2", () => {
  it("is false where the page can make no WebGL 2 context", () => {
    expect(hasWebgl2()).toBe(false);
  });
});
