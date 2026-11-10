import { LOCALE_TAGS } from "@gerlines/i18n";
import { useProfileCopy } from "@gerlines/i18n/profile";
import { useLocale } from "@gerlines/i18n/react";
import { useEffect, useRef } from "react";
import { useAppStore } from "../state/store.ts";
import { describeLeg } from "./format.ts";
import { useHeldHover } from "./use-held-hover.ts";

const OFFSET_PX = 14;
const WIDTH_PX = 288;

interface Text {
  readonly title: string;
  readonly lines: readonly { readonly label: string; readonly value: string }[];
}

/** The drawn tooltip: when it goes away under a resting pointer no leave event comes, so it lets go of the hover itself. */
function TooltipBody({
  text,
  left,
  top,
  enter,
  leave,
}: {
  text: Text;
  left: number;
  top: number;
  enter: () => void;
  leave: () => void;
}) {
  useEffect(() => leave, [leave]);
  return (
    <div
      data-slot="profile-tooltip"
      className="card-surface pointer-events-auto fixed z-30 flex w-72 flex-col gap-1 px-3 py-2"
      onPointerEnter={enter}
      onPointerLeave={leave}
      style={{ left, top }}
    >
      <p className="type-label break-words">{text.title}</p>
      {text.lines.map((line) => (
        <p key={line.label} className="type-caption flex flex-col text-ink-muted">
          <span className="text-ink">{line.label}</span>
          <span>{line.value}</span>
        </p>
      ))}
    </div>
  );
}

/** The figures of the leg under the pointer on the map: the words of the card's list, from the same function. */
export default function ProfileTooltip() {
  const copy = useProfileCopy();
  const locale = LOCALE_TAGS[useLocale()];
  const profile = useAppStore((state) => state.profile);
  const hover = useAppStore((state) => state.profileHover);
  const setProfileHover = useAppStore((state) => state.setProfileHover);
  const { shown, enter, leave, dismiss } = useHeldHover(hover);
  const leg = shown ? profile?.legs.find((candidate) => candidate.index === shown.leg) : undefined;
  const drawn = shown !== null && profile !== null && leg !== undefined;
  const showing = useRef(false);
  showing.current = drawn;
  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !showing.current) return;
      event.preventDefault();
      dismiss();
      setProfileHover(null);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [dismiss, setProfileHover]);
  if (!(shown && profile && leg)) return null;
  const text = describeLeg(leg, profile.quantile, copy.profile, copy.delay.minutes, locale);
  const room = window.innerWidth - shown.x - OFFSET_PX;
  const left = room >= WIDTH_PX ? shown.x + OFFSET_PX : Math.max(8, shown.x - OFFSET_PX - WIDTH_PX);
  return (
    <TooltipBody
      text={text}
      left={left}
      top={Math.max(8, shown.y + OFFSET_PX)}
      enter={enter}
      leave={leave}
    />
  );
}
