import { useCopy, useFormatters } from "@gerlines/i18n/react";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@gerlines/ui";
import { Info } from "lucide-react";
import type { TrainCardModel } from "../model.ts";

function positionSentence(model: TrainCardModel, copy: ReturnType<typeof useCopy>): string | null {
  if (model.cancelled) return null;
  if (model.notDrawn) return null;
  if (model.noGeometry) return copy.train.notOnMap;
  return model.realtime ? copy.card.positionEstimated : null;
}

export function Provenance({ model }: { model: TrainCardModel }) {
  const copy = useCopy();
  const train = useCopy().train;
  const { clock, day } = useFormatters();
  const source = train.attribution(model.source.attribution).replace(/\.$/, "");
  const sentences: (string | null)[] = [
    model.realtime ? train.realtimeSource(source) : train.timetableSource(source),
    model.realtime ? copy.card.dataFrom(clock(model.dataTimeMs), day(model.dataTimeMs)) : null,
    model.stale ? copy.card.staleData : null,
    model.refreshFailed ? train.refreshFailed : null,
    positionSentence(model, copy),
  ];
  const text = sentences.filter((sentence) => sentence !== null).join(" ");
  return (
    <div className="flex flex-col gap-1 border-t px-4 pt-3">
      <p className="type-caption text-ink-muted">{text}</p>
      {model.onMap ? (
        <Popover>
          <PopoverTrigger className="focus-ring type-caption -ml-1 inline-flex min-h-target w-fit cursor-pointer items-center gap-1.5 rounded-md px-1 text-ink underline decoration-1 underline-offset-[3px] hover:bg-raised">
            <Info aria-hidden="true" className="size-3.5 text-ink-muted" />
            {train.positionHow}
          </PopoverTrigger>
          <PopoverContent side="top" align="start">
            <PopoverTitle>{train.positionHow}</PopoverTitle>
            <PopoverDescription>
              {model.realtime ? train.positionHowRealtime(source) : train.positionHowTimetable}
            </PopoverDescription>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
