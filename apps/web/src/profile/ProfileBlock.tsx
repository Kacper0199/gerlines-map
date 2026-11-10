import { LOCALE_TAGS } from "@gerlines/i18n";
import { useProfileCopy } from "@gerlines/i18n/profile";
import { useFormatters, useLocale } from "@gerlines/i18n/react";
import type { StatsTrainSegments } from "@gerlines/schema/stats";
import { Button, Notice, ToggleGroup, ToggleGroupItem } from "@gerlines/ui";
import { Layers } from "lucide-react";
import { useAppStore } from "../state/store.ts";
import { useCooldown } from "../stats/use-cooldown.ts";
import { ProfileLegend } from "./ProfileLegend.tsx";
import { ProfileLegList } from "./ProfileLegList.tsx";
import type { ProfileCardSubject } from "./subject.ts";
import { useProfileLegs } from "./use-profile-legs.ts";
import { useProfileRange } from "./use-profile-range.ts";

function Groups({ data }: { data: StatsTrainSegments }) {
  const { profile, categories } = useProfileCopy();
  const shown = data.groups.find((group) => group.shown);
  const others = data.groups.filter((group) => !group.shown).length;
  const badge = shown?.category
    ? ((categories as Record<string, { badge: string } | undefined>)[shown.category]?.badge ??
      shown.category)
    : "";
  return (
    <>
      {shown ? (
        <p className="type-caption text-ink-muted">
          {profile
            .group(badge, shown.operator?.name ?? "", profile.runs(shown.runs))
            .replace(/ {2,}/g, " ")}
        </p>
      ) : null}
      {others > 0 ? <p className="type-caption text-ink-muted">{profile.others(others)}</p> : null}
    </>
  );
}

function Body({ subject }: { subject: ProfileCardSubject }) {
  const copy = useProfileCopy();
  const { profile } = copy;
  const locale = LOCALE_TAGS[useLocale()];
  const theme = useAppStore((state) => state.theme);
  const quantile = useAppStore((state) => state.profileQuantile);
  const view = useAppStore((state) => state.profileView);
  const routeStops = useAppStore((state) => state.routeStops);
  const retry = useAppStore((state) => state.retryProfile);
  const range = useProfileRange();
  const { day } = useFormatters();
  const built = useProfileLegs(subject, view.state === "ready" ? view.data : null, routeStops);
  const waiting = useCooldown(view.state === "failed" ? view.retryAfterS : undefined, view);
  if (view.state === "idle" || view.state === "loading") {
    return (
      <p className="type-caption text-ink-muted" aria-live="polite">
        {profile.loading}
      </p>
    );
  }
  if (view.state === "failed") {
    return (
      <Notice
        tone="error"
        role="alert"
        action={
          <Button variant="quiet" disabled={waiting > 0} onClick={retry}>
            {waiting > 0 ? profile.retryIn(waiting) : profile.retry}
          </Button>
        }
      >
        {profile.error}
      </Notice>
    );
  }
  if (built === null) return null;
  const empty = view.data.segments.length === 0;
  const from = day(Date.parse(`${range.from}T12:00:00Z`));
  const to = day(Date.parse(`${range.to}T12:00:00Z`));
  return (
    <>
      <p className="type-caption text-ink-muted">{profile.period(from, to)}</p>
      {empty ? <p className="type-body">{profile.empty}</p> : <Groups data={view.data} />}
      {empty ? null : (
        <>
          {built.placed ? null : <p className="type-caption text-ink-muted">{profile.notPlaced}</p>}
          <ProfileLegend
            copy={profile}
            theme={theme}
            unit={copy.delay.minutes}
            curtain={built.placed}
          />
          <ProfileLegList
            legs={built.legs}
            quantile={quantile}
            copy={profile}
            unit={copy.delay.minutes}
            locale={locale}
            theme={theme}
          />
          {built.sameNameOtherIds > 0 ? (
            <p className="type-caption text-ink-muted">
              {profile.idsDiffer(built.sameNameOtherIds)}
            </p>
          ) : null}
          <p className="type-caption text-ink-muted">{profile.note}</p>
        </>
      )}
    </>
  );
}

/**
 * The segment profile of the card's train (R-09): a switch that draws its route in the colour of each leg's
 * delay gain against all trains and, in a tilted view, the curtain over it, with the legend and the figures
 * of every leg. The block shows what the profile controller fetched; nothing is asked of the API until the
 * switch is on.
 */
export default function ProfileBlock({ subject }: { subject: ProfileCardSubject }) {
  const { profile } = useProfileCopy();
  const on = useAppStore((state) => state.profileOn);
  const quantile = useAppStore((state) => state.profileQuantile);
  const setOn = useAppStore((state) => state.setProfileOn);
  const setQuantile = useAppStore((state) => state.setProfileQuantile);
  return (
    <section aria-label={profile.title} className="flex flex-col gap-2 border-t px-4 pt-3 pb-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="type-label text-ink-muted">{profile.title}</h3>
        <Button
          variant={on ? "selection" : "secondary"}
          aria-pressed={on}
          onClick={() => setOn(!on)}
        >
          <Layers aria-hidden="true" />
          {on ? profile.close : profile.open}
        </Button>
      </div>
      {on ? (
        <>
          <ToggleGroup
            aria-label={profile.measure.label}
            value={[quantile]}
            onValueChange={(value) => {
              if (value[0] === "median" || value[0] === "p80") setQuantile(value[0]);
            }}
            className="w-full shadow-none"
          >
            <ToggleGroupItem value="median" className="h-target flex-1">
              {profile.measure.median}
            </ToggleGroupItem>
            <ToggleGroupItem value="p80" className="h-target flex-1">
              {profile.measure.p80}
            </ToggleGroupItem>
          </ToggleGroup>
          <Body subject={subject} />
        </>
      ) : null}
    </section>
  );
}
