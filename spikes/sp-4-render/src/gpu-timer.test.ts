import { describe, expect, it } from "vitest";
import { GpuTimer } from "./gpu-timer.ts";

function fakeContext() {
  const state = { available: false, disjoint: false, resultNanoseconds: 2_000_000 };
  const created: object[] = [];
  const deleted: object[] = [];
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }),
    createQuery: () => {
      const query = {};
      created.push(query);
      return query;
    },
    beginQuery: () => undefined,
    endQuery: () => undefined,
    deleteQuery: (query: object) => void deleted.push(query),
    getQueryParameter: (_query: object, name: number) =>
      name === 1 ? state.available : state.resultNanoseconds,
    getParameter: () => state.disjoint,
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state, created, deleted };
}

function drive() {
  const context = fakeContext();
  const timer = new GpuTimer();
  const [begin, end] = timer.layers();
  begin.onAdd?.(undefined as never, context.gl);
  timer.startRecording();
  const frame = () => {
    begin.render(context.gl, undefined as never);
    end.render(context.gl, undefined as never);
  };
  return { ...context, timer, frame };
}

describe("GpuTimer", () => {
  it("records one sample per finished query", () => {
    const { timer, state, frame } = drive();
    frame();
    state.available = true;
    frame();
    const result = timer.stopRecording();
    expect(result.samplesMs).toEqual([2, 2]);
    expect(result.disjointFrames).toBe(0);
  });

  it("drops every pending query when the disjoint flag is raised", () => {
    const { timer, state, created, deleted, frame } = drive();
    frame();
    frame();
    state.available = true;
    state.disjoint = true;
    frame();
    expect(deleted.length).toBe(created.length);
    state.disjoint = false;
    frame();
    const result = timer.stopRecording();
    expect(result.disjointFrames).toBe(1);
    expect(result.samplesMs).toEqual([2]);
  });
});
