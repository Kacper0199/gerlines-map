import { useCopy } from "@gerlines/i18n/react";
import type { TrainPhoto } from "@gerlines/schema";
import { ThemeProvider, TooltipProvider } from "@gerlines/ui";
import type { ThemeName } from "@gerlines/ui/tokens";
import { useEffect, useState } from "react";
import { loadCredits } from "../../../credits/CreditsPage.tsx";
import { PHONE_QUERY, useMediaQuery } from "../../../hooks/use-media-query.ts";
import { LiveTrainCard } from "../card/LiveTrainCard.tsx";
import { TRAIN_FIXTURES } from "../fixtures/index.ts";
import {
  availableStates,
  type CardStateSpec,
  detailFor,
  fakeTrainServer,
  nowFor,
  stationIndex,
} from "./states.ts";

/** The rank 1 photo the API serves for a series, or null when it has none or answers 503. */
function useSeriesPhoto(seriesId: string | undefined): TrainPhoto | null | undefined {
  const [photo, setPhoto] = useState<TrainPhoto | null | undefined>(undefined);
  useEffect(() => {
    if (!seriesId) return;
    loadCredits(fetch).then(
      (photos) => {
        const found = photos.find((candidate) => candidate.seriesId === seriesId);
        if (!found) return setPhoto(null);
        const { seriesName: _name, ...trainPhoto } = found;
        setPhoto(trainPhoto);
      },
      () => setPhoto(null),
    );
  }, [seriesId]);
  return seriesId ? photo : null;
}

function StateView({
  spec,
  phone,
  expanded,
}: {
  spec: CardStateSpec;
  phone: boolean;
  expanded: boolean;
}) {
  const fixture = TRAIN_FIXTURES[spec.fixture];
  const photo = useSeriesPhoto(spec.vehicle?.seriesId);
  if (!fixture || photo === undefined) {
    return null;
  }
  const detail = detailFor(spec, fixture.detail, photo);
  const station = stationIndex(spec, detail);
  const card = (
    <LiveTrainCard
      key={`${spec.name}-${phone}`}
      tripInstanceId={detail.tripInstanceId}
      phone={phone}
      onClose={() => undefined}
      fetch={fakeTrainServer(spec.reply, detail)}
      frozenNowMs={nowFor(detail)}
      {...(spec.reply === "refresh-error" ? { refreshMs: 500 } : {})}
      defaultStopsOpen={spec.stopsOpen ?? false}
      defaultExpanded={expanded}
      {...(station !== undefined ? { defaultStationIndex: station } : {})}
    />
  );
  if (phone) {
    return <div className="pointer-events-none fixed inset-0">{card}</div>;
  }
  return (
    <div className="pointer-events-none fixed inset-y-0 left-0 flex w-[412px] flex-col p-4 max-[1200px]:w-[392px]">
      {card}
    </div>
  );
}

function Index({ states }: { states: readonly CardStateSpec[] }) {
  const copy = useCopy();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="type-headline">{copy.card.label}</h1>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {states.map((spec) => (
          <li key={spec.name}>
            <a className="focus-ring type-body-strong underline" href={`?state=${spec.name}`}>
              {spec.name}
            </a>
          </li>
        ))}
      </ul>
      <p className="type-caption text-ink-muted">
        {Object.values(TRAIN_FIXTURES)
          .map(({ fixture }) => `${fixture.name}: ${fixture.database}, ${fixture.asOf}`)
          .join(". ")}
      </p>
    </main>
  );
}

export function StatesPage({ theme, search }: { theme: ThemeName; search: string }) {
  const params = new URLSearchParams(search);
  const phoneWidth = useMediaQuery(PHONE_QUERY);
  const layout = params.get("layout");
  const phone = layout === "sheet" || (layout !== "panel" && phoneWidth);
  const states = availableStates();
  const spec = states.find((candidate) => candidate.name === params.get("state"));
  return (
    <ThemeProvider theme={theme}>
      <TooltipProvider>
        <div className="min-h-dvh bg-map-land">
          {spec ? (
            <main>
              <h1 className="sr-only">{spec.name}</h1>
              <StateView spec={spec} phone={phone} expanded={params.get("expanded") === "1"} />
            </main>
          ) : (
            <Index states={states} />
          )}
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
