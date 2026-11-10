import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";

interface TimerExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export const GPU_TIMER_BEGIN_ID = "gpu-timer-begin";
export const GPU_TIMER_END_ID = "gpu-timer-end";

export class GpuTimer {
  private extension: TimerExtension | null = null;
  private open: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  private samples: number[] = [];
  private disjointFrames = 0;
  private recording = false;
  supported = false;

  private poll(gl: WebGL2RenderingContext): void {
    const extension = this.extension;
    if (!extension) return;
    while (this.pending.length > 0) {
      const query = this.pending[0] as WebGLQuery;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = Boolean(gl.getParameter(extension.GPU_DISJOINT_EXT));
      if (disjoint) {
        this.disjointFrames++;
        this.dropPending(gl);
        return;
      }
      if (this.recording)
        this.samples.push(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6);
      gl.deleteQuery(query);
      this.pending.shift();
    }
  }

  private dropPending(gl: WebGL2RenderingContext): void {
    for (const query of this.pending) gl.deleteQuery(query);
    this.pending = [];
  }

  private begin(gl: WebGL2RenderingContext): void {
    const extension = this.extension;
    if (!extension || this.open || this.pending.length > 6) return;
    const query = gl.createQuery();
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    this.open = query;
  }

  private end(gl: WebGL2RenderingContext): void {
    const extension = this.extension;
    if (!extension || !this.open) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    this.pending.push(this.open);
    this.open = null;
    this.poll(gl);
  }

  layers(): [CustomLayerInterface, CustomLayerInterface] {
    const begin: CustomLayerInterface = {
      id: GPU_TIMER_BEGIN_ID,
      type: "custom",
      renderingMode: "2d",
      onAdd: (_map: MapLibreMap, gl: WebGL2RenderingContext) => {
        this.extension = gl.getExtension(
          "EXT_disjoint_timer_query_webgl2",
        ) as TimerExtension | null;
        this.supported = this.extension !== null;
      },
      render: (gl) => this.begin(gl as WebGL2RenderingContext),
    };
    const end: CustomLayerInterface = {
      id: GPU_TIMER_END_ID,
      type: "custom",
      renderingMode: "2d",
      render: (gl) => this.end(gl as WebGL2RenderingContext),
    };
    return [begin, end];
  }

  startRecording(): void {
    this.samples = [];
    this.disjointFrames = 0;
    this.recording = true;
  }

  stopRecording(): { samplesMs: number[]; disjointFrames: number } {
    this.recording = false;
    return { samplesMs: this.samples, disjointFrames: this.disjointFrames };
  }
}
