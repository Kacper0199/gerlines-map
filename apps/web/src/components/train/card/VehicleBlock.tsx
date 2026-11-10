import type { Copy, Locale } from "@gerlines/i18n";
import { useCopy, useLocale } from "@gerlines/i18n/react";
import { useVehicleCopy } from "@gerlines/i18n/vehicle";
import type { TrainPhoto, VehicleIdentity } from "@gerlines/schema";
import { cn } from "@gerlines/ui";
import {
  type BodyTable,
  IDENTICAL_BODY_TABLE,
  relatedBody,
} from "../../../cars/identical-bodies.ts";
import { seriesDisplayName, sourceDisplayName, vehicleFactParts } from "./vehicle-labels.ts";

export function confidenceLabel(confidence: number, copy: Copy["train"]): string {
  if (confidence >= 0.9) {
    return copy.confidence.high;
  }
  return confidence >= 0.6 ? copy.confidence.medium : copy.confidence.low;
}

export function seriesLabel(vehicle: VehicleIdentity, locale: Locale): string {
  const name = seriesDisplayName(vehicle, locale);
  return vehicle.variant ? `${name} ${vehicle.variant}` : name;
}

const CREDIT_LINK = "focus-ring rounded-sm underline decoration-1 underline-offset-2";

export function focusPosition(photo: TrainPhoto): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return `${percent(photo.focus.x)} ${percent(photo.focus.y)}`;
}

/** The Commons file title as the work's title, without the file extension. */
export function photoTitle(photo: Pick<TrainPhoto, "title">): string {
  return photo.title.replace(/\.(jpe?g|png)$/i, "");
}

export function photoSources(photo: TrainPhoto): string {
  return `${photo.small.url} ${photo.small.width}w, ${photo.large.url} ${photo.large.width}w`;
}

function Photo({ photo, alt, wide }: { photo: TrainPhoto; alt: string; wide: boolean }) {
  const copy = useCopy();
  return (
    <figure className={cn("flex flex-col gap-1", wide ? "w-full" : "w-24 shrink-0")}>
      <img
        src={photo.small.url}
        srcSet={photoSources(photo)}
        sizes={wide ? "(max-width: 480px) 100vw, 380px" : "96px"}
        width={photo.small.width}
        height={photo.small.height}
        alt={alt}
        loading="lazy"
        decoding="async"
        style={{ objectPosition: focusPosition(photo) }}
        className="aspect-[3/2] w-full rounded-md bg-raised object-cover"
      />
      <figcaption className="type-caption break-words text-ink-muted">
        <a href={photo.sourceUrl} className={CREDIT_LINK} target="_blank" rel="noreferrer">
          {photoTitle(photo)}
        </a>
        {`. ${copy.train.photoBy(photo.author)}, `}
        {photo.licenceUrl ? (
          <a
            href={photo.licenceUrl}
            className={cn(CREDIT_LINK, "whitespace-nowrap")}
            target="_blank"
            rel="license noreferrer"
          >
            {photo.licence}
          </a>
        ) : (
          <span className="whitespace-nowrap">{photo.licence}</span>
        )}
        {`. ${copy.photos.cropped}.`}
      </figcaption>
    </figure>
  );
}

function Facts({ vehicle, bodies }: { vehicle: VehicleIdentity; bodies: BodyTable }) {
  const train = useCopy().train;
  const vehicleCopy = useVehicleCopy();
  const related = relatedBody(vehicle.seriesId, bodies);
  const locale = useLocale();
  const parts = vehicleFactParts(vehicle, locale);
  const source = sourceDisplayName(vehicle, vehicleCopy);
  const confidence = confidenceLabel(vehicle.confidence, train);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="type-body-strong">{seriesLabel(vehicle, locale)}</span>
      {parts.length > 0 ? (
        <span className="num type-data-small text-ink-muted">{parts.join(", ")}</span>
      ) : null}
      <span className="type-caption text-ink-muted">
        {source === null ? confidence : `${confidence}. ${train.vehicleSource(source)}`}
      </span>
      {related ? (
        <span className="type-caption text-ink-muted">
          {train.vehicleRelatedModel(related.relatedName)}
        </span>
      ) : null}
    </div>
  );
}

export function VehicleBlock({
  vehicle,
  photo,
  wide,
  bodies = IDENTICAL_BODY_TABLE,
}: {
  vehicle: VehicleIdentity | null;
  photo: TrainPhoto | null;
  wide: boolean;
  bodies?: BodyTable;
}) {
  const train = useCopy().train;
  const locale = useLocale();
  return (
    <section aria-label={train.vehicle} className="flex flex-col gap-2 border-t px-4 pt-3 pb-3">
      <h3 className="type-label text-ink-muted">{train.vehicle}</h3>
      {vehicle === null ? (
        <div className="flex flex-col gap-0.5">
          <span className="type-body-strong">{train.vehicleMissing}</span>
          <span className="type-caption text-ink-muted">{train.vehicleMissingNote}</span>
        </div>
      ) : (
        <div className={cn("flex gap-3", wide ? "flex-col" : "items-start justify-between")}>
          <Facts vehicle={vehicle} bodies={bodies} />
          {photo ? (
            <Photo photo={photo} alt={seriesLabel(vehicle, locale)} wide={wide} />
          ) : (
            <span className="type-caption text-ink-muted">{train.photoMissing}</span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One line of the collapsed card: the series and what the data knows of the set, with the full block one
 * click deeper. A generic model (layer L4) is a guess from the category alone with a confidence of about
 * 10 %, so the line leaves it out and the block shows it with its confidence.
 */
export function VehicleSummary({ vehicle }: { vehicle: VehicleIdentity }) {
  const train = useCopy().train;
  const locale = useLocale();
  if (vehicle.layer === "L4") return null;
  const series = seriesLabel(vehicle, locale);
  const facts = vehicleFactParts(vehicle, locale);
  return (
    <p
      data-slot="vehicle-summary"
      title={`${train.vehicle}: ${[series, ...facts].join(", ")}. ${confidenceLabel(vehicle.confidence, train)}`}
      className="type-caption -mt-2 shrink-0 truncate px-4 pl-[52px] text-ink-muted"
    >
      <span className="type-body-strong text-ink">{series}</span>
      {facts.length > 0 ? <span className="num">{`, ${facts.join(", ")}`}</span> : null}
    </p>
  );
}
