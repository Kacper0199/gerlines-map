export const SHAPE_CELL = 64;
export const CHEVRON_STROKE = 7;

export const CHEVRON_POINTS: readonly (readonly [number, number])[] = [
  [32, 5],
  [55, 58],
  [32, 46],
  [9, 58],
];

export const CHEVRON_PATH = `M${CHEVRON_POINTS.map(([x, y]) => `${x} ${y}`).join("L")}Z`;

export const DOT_RADIUS = 30;
export const DOT_RING_STROKE = 11;

export const CATEGORY_ATLAS_ICONS = {
  chevron: {
    x: 0,
    y: 0,
    width: SHAPE_CELL,
    height: SHAPE_CELL,
    anchorY: SHAPE_CELL / 2,
    mask: true,
  },
  "chevron-hollow": {
    x: SHAPE_CELL,
    y: 0,
    width: SHAPE_CELL,
    height: SHAPE_CELL,
    anchorY: SHAPE_CELL / 2,
    mask: true,
  },
} as const;

export interface PathContext {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineJoin: CanvasLineJoin;
}

export function traceChevron(context: PathContext, offsetX: number): void {
  context.beginPath();
  CHEVRON_POINTS.forEach(([x, y], index) => {
    if (index === 0) {
      context.moveTo(offsetX + x, y);
    } else {
      context.lineTo(offsetX + x, y);
    }
  });
  context.closePath();
}

export function drawCategoryAtlas(context: PathContext): void {
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#ffffff";
  context.lineJoin = "round";
  traceChevron(context, 0);
  context.fill();
  context.lineWidth = CHEVRON_STROKE;
  traceChevron(context, SHAPE_CELL);
  context.stroke();
}

export function createCategoryAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SHAPE_CELL * 2;
  canvas.height = SHAPE_CELL;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("A 2D canvas is needed to draw the train chevrons");
  }
  drawCategoryAtlas(context);
  return canvas;
}
