const CELL = 64;
const STROKE = 7;

export const CHEVRON_ICONS = {
  chevron: { x: 0, y: 0, width: CELL, height: CELL, anchorY: CELL / 2, mask: true },
  "chevron-hollow": { x: CELL, y: 0, width: CELL, height: CELL, anchorY: CELL / 2, mask: true },
} as const;

function tracePath(context: CanvasRenderingContext2D, offsetX: number): void {
  context.beginPath();
  context.moveTo(offsetX + CELL / 2, 5);
  context.lineTo(offsetX + CELL - 9, CELL - 6);
  context.lineTo(offsetX + CELL / 2, CELL - 18);
  context.lineTo(offsetX + 9, CELL - 6);
  context.closePath();
}

export function createChevronAtlas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * 2;
  canvas.height = CELL;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("A 2D canvas is needed to draw the train chevrons");
  }
  context.fillStyle = "#ffffff";
  context.strokeStyle = "#ffffff";
  context.lineJoin = "round";
  tracePath(context, 0);
  context.fill();
  context.lineWidth = STROKE;
  tracePath(context, CELL);
  context.stroke();
  return canvas;
}
