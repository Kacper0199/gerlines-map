import { z } from "zod";
import { nodeHttpFetch } from "./http-fetch.ts";

const placeSchema = z.object({
  name: z.string(),
  stopId: z.string().optional(),
  lat: z.number(),
  lon: z.number(),
  arrival: z.string().optional(),
  departure: z.string().optional(),
  scheduledArrival: z.string().optional(),
  scheduledDeparture: z.string().optional(),
  track: z.string().optional(),
  scheduledTrack: z.string().optional(),
  cancelled: z.boolean().optional(),
});

const legSchema = z.object({
  mode: z.string(),
  from: placeSchema,
  to: placeSchema,
  duration: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  scheduledStartTime: z.string(),
  scheduledEndTime: z.string(),
  realTime: z.boolean(),
  headsign: z.string().optional(),
  tripTo: placeSchema.optional(),
  routeType: z.number().int().optional(),
  routeId: z.string().optional(),
  agencyName: z.string().optional(),
  tripId: z.string().optional(),
  routeShortName: z.string().optional(),
  tripShortName: z.string().optional(),
  displayName: z.string().optional(),
  cancelled: z.boolean().optional(),
  interlineWithPreviousLeg: z.boolean().optional(),
  distance: z.number().optional(),
  legGeometry: z
    .object({ points: z.string(), precision: z.number().int(), length: z.number().int() })
    .optional(),
});

const itinerarySchema = z.object({
  duration: z.number(),
  startTime: z.string(),
  endTime: z.string(),
  transfers: z.number().int(),
  legs: z.array(legSchema),
});

export const planResponseSchema = z.object({
  itineraries: z.array(itinerarySchema),
  previousPageCursor: z.string().optional(),
  nextPageCursor: z.string().optional(),
});

export type MotisPlace = z.infer<typeof placeSchema>;
export type MotisLeg = z.infer<typeof legSchema>;
export type MotisItinerary = z.infer<typeof itinerarySchema>;
export type PlanResponse = z.infer<typeof planResponseSchema>;

export interface PlanRequest {
  readonly fromPlace: string;
  readonly toPlace: string;
  readonly time: string;
  readonly arriveBy: boolean;
  readonly transitModes?: readonly string[] | undefined;
  readonly numItineraries: number;
  readonly maxTransfers?: number | undefined;
  readonly pageCursor?: string | undefined;
  /** Asks MOTIS for each transit leg's line on the track; transfer lines stay empty. */
  readonly detailedLegs?: boolean | undefined;
  /** Gives up sooner than the client's plan timeout; never sent to MOTIS. */
  readonly timeoutMs?: number | undefined;
  /** Aborts the call when the caller goes away, beside the timeout; never sent to MOTIS. */
  readonly signal?: AbortSignal | undefined;
}

export interface RouterHealth {
  readonly ok: boolean;
  readonly latencyMs: number;
}

export interface RouterClient {
  plan(request: PlanRequest): Promise<PlanResponse>;
  health(): Promise<RouterHealth>;
}

export class RouterUnavailableError extends Error {
  override readonly name = "RouterUnavailableError";
}

export class RouterBusyError extends Error {
  override readonly name = "RouterBusyError";
}

export class RouterRejectedError extends Error {
  override readonly name = "RouterRejectedError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface RouterClientOptions {
  readonly baseUrl: string;
  readonly userAgent: string;
  readonly fetch?: typeof fetch;
  readonly planTimeoutMs?: number;
  readonly healthTimeoutMs?: number;
  readonly now?: () => number;
}

const errorBodySchema = z.object({ error: z.string() });

function planUrl(baseUrl: string, request: PlanRequest): URL {
  const url = new URL("/api/v6/plan", baseUrl);
  const params = url.searchParams;
  params.set("fromPlace", request.fromPlace);
  params.set("toPlace", request.toPlace);
  params.set("time", request.time);
  params.set("arriveBy", String(request.arriveBy));
  if (request.transitModes) {
    params.set("transitModes", request.transitModes.join(","));
  }
  params.set("directModes", "");
  params.set("numItineraries", String(request.numItineraries));
  if (request.maxTransfers !== undefined) {
    params.set("maxTransfers", String(request.maxTransfers));
  }
  params.set("detailedLegs", String(request.detailedLegs ?? false));
  if (request.detailedLegs) {
    params.set("detailedTransfers", "false");
  }
  params.set("joinInterlinedLegs", "false");
  if (request.pageCursor) {
    params.set("pageCursor", request.pageCursor);
  }
  return url;
}

async function rejection(response: Response): Promise<RouterRejectedError> {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => undefined));
  const message = parsed.success ? parsed.data.error : `MOTIS answered ${response.status}`;
  return new RouterRejectedError(response.status, message);
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = (error as { code?: unknown }).code;
  const text = `${error.name}${typeof code === "string" ? ` ${code}` : ""}: ${error.message}`;
  return error.cause === undefined ? text : `${text} (cause ${describe(error.cause)})`;
}

export function createRouterClient({
  baseUrl,
  userAgent,
  fetch: fetchImpl = nodeHttpFetch as typeof fetch,
  planTimeoutMs = 20_000,
  healthTimeoutMs = 3_000,
  now = performance.now.bind(performance),
}: RouterClientOptions): RouterClient {
  const headers = { Accept: "application/json", "User-Agent": userAgent };

  async function get(url: URL, timeoutMs: number, caller?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
    try {
      return await fetchImpl(url, { headers, signal });
    } catch (error) {
      throw new RouterUnavailableError(`MOTIS did not answer: ${describe(error)}`);
    }
  }

  return {
    async plan(request) {
      const timeoutMs = Math.min(request.timeoutMs ?? planTimeoutMs, planTimeoutMs);
      const response = await get(planUrl(baseUrl, request), timeoutMs, request.signal);
      if (response.status >= 400 && response.status < 500) {
        throw await rejection(response);
      }
      if (!response.ok) {
        throw new RouterUnavailableError(`MOTIS answered ${response.status}`);
      }
      const parsed = planResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new RouterUnavailableError(
          `MOTIS plan answer has an unexpected shape: ${parsed.error.message}`,
        );
      }
      return parsed.data;
    },

    async health() {
      const started = now();
      try {
        const response = await get(new URL("/api/v1/health", baseUrl), healthTimeoutMs);
        await response.body?.cancel();
        return { ok: response.ok, latencyMs: Math.round(now() - started) };
      } catch {
        return { ok: false, latencyMs: Math.round(now() - started) };
      }
    },
  };
}

export function limitPlansInFlight(client: RouterClient, maxInFlight: number): RouterClient {
  let inFlight = 0;
  return {
    async plan(request) {
      if (inFlight >= maxInFlight) {
        throw new RouterBusyError(
          `${inFlight} MOTIS plan calls in flight, the limit is ${maxInFlight}`,
        );
      }
      inFlight += 1;
      try {
        return await client.plan(request);
      } finally {
        inFlight -= 1;
      }
    },
    health: () => client.health(),
  };
}
