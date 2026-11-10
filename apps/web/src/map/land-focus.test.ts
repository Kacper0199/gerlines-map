import { describe, expect, it, vi } from "vitest";
import type { LandFacts } from "./geo-base.ts";
import { type FocusCamera, type FocusLook, focusLand } from "./land-focus.ts";
import type { LandCode } from "./style/map-styles.ts";

function land(code: LandCode): LandFacts {
  return {
    code,
    names: { en: code, de: code, pl: code },
    label: [10, 51],
    fit: [
      [9, 50],
      [11, 52],
    ],
  };
}

function setup(alive = true) {
  let release: (facts: readonly LandFacts[]) => void = () => undefined;
  const pending = new Promise<readonly LandFacts[]>((resolve) => {
    release = resolve;
  });
  const look: FocusLook & { current: { focus: LandCode | null } } = {
    current: { focus: null },
    update: vi.fn((patch: { focus: LandCode | null }) => {
      look.current = { focus: patch.focus };
    }),
    laender: () => pending,
  };
  const camera: FocusCamera = {
    fitGermany: vi.fn(),
    fitLand: vi.fn(),
    alive: () => alive,
  };
  return { look, camera, release: () => release([land("DE-BY"), land("DE-BE")]) };
}

describe("focusLand", () => {
  it("fits the focused Land once its facts are known", async () => {
    const { look, camera, release } = setup();
    const done = focusLand(look, camera, "DE-BY");
    release();
    await done;

    expect(look.current.focus).toBe("DE-BY");
    expect(camera.fitLand).toHaveBeenCalledWith(land("DE-BY").fit);
  });

  it("drops a stale focus when another Land was chosen while the facts loaded", async () => {
    const { look, camera, release } = setup();
    const first = focusLand(look, camera, "DE-BY");
    const second = focusLand(look, camera, "DE-BE");
    release();
    await Promise.all([first, second]);

    expect(camera.fitLand).toHaveBeenCalledTimes(1);
    expect(camera.fitLand).toHaveBeenCalledWith(land("DE-BE").fit);
  });

  it("does nothing after the map was disposed", async () => {
    const { look, camera, release } = setup(false);
    const done = focusLand(look, camera, "DE-BY");
    release();
    await done;

    expect(camera.fitLand).not.toHaveBeenCalled();
  });

  it("ignores a value that is not a Land code", async () => {
    const { look, camera } = setup();
    await focusLand(look, camera, "../../etc");

    expect(look.update).not.toHaveBeenCalled();
    expect(camera.fitGermany).not.toHaveBeenCalled();
  });

  it("returns to Germany when the focus is cleared", async () => {
    const { look, camera, release } = setup();
    const done = focusLand(look, camera, "DE-BY");
    release();
    await done;
    await focusLand(look, camera, null);

    expect(look.current.focus).toBeNull();
    expect(camera.fitGermany).toHaveBeenCalledTimes(1);
  });
});
