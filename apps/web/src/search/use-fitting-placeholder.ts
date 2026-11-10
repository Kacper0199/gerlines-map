import { type RefObject, useLayoutEffect, useState } from "react";

const SAFETY_PX = 4;

export function pickFitting(
  candidates: readonly [string, ...string[]],
  available: number,
  widthOf: (text: string) => number,
): string {
  const fitting = candidates.find((text) => widthOf(text) <= available);
  return fitting ?? candidates[candidates.length - 1] ?? candidates[0];
}

function textWidthOf(input: HTMLInputElement): ((text: string) => number) | null {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) {
    return null;
  }
  const style = getComputedStyle(input);
  context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (text) => context.measureText(text).width;
}

function contentWidthOf(input: HTMLInputElement): number {
  const style = getComputedStyle(input);
  return (
    input.clientWidth -
    Number.parseFloat(style.paddingLeft || "0") -
    Number.parseFloat(style.paddingRight || "0") -
    SAFETY_PX
  );
}

function useFieldWidth(input: RefObject<HTMLInputElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = input.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [input]);
  return width;
}

function useFontEpoch(): number {
  const [epoch, setEpoch] = useState(0);
  useLayoutEffect(() => {
    const fonts = document.fonts;
    if (!fonts) {
      return undefined;
    }
    const bump = () => setEpoch((count) => count + 1);
    void fonts.ready.then(bump);
    fonts.addEventListener("loadingdone", bump);
    return () => fonts.removeEventListener("loadingdone", bump);
  }, []);
  return epoch;
}

/**
 * The longest of `candidates` (longest first) that fits the field without an ellipsis, measured in
 * the field's own font, so no width or language needs its own breakpoint. Without layout (or a
 * canvas) the first candidate stays.
 */
export function useFittingPlaceholder(
  input: RefObject<HTMLInputElement | null>,
  candidates: readonly [string, ...string[]],
): string {
  const fieldWidth = useFieldWidth(input);
  const fontEpoch = useFontEpoch();
  const [chosen, setChosen] = useState(candidates[0]);
  const signature = candidates.join("\n");
  useLayoutEffect(() => {
    const element = input.current;
    const widthOf = element && fieldWidth > 0 ? textWidthOf(element) : null;
    setChosen(
      element && widthOf
        ? pickFitting(candidates, contentWidthOf(element), widthOf)
        : candidates[0],
    );
  }, [input, signature, fieldWidth, fontEpoch]);
  return chosen;
}
