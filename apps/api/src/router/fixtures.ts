import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type PlanRequest,
  type PlanResponse,
  planResponseSchema,
  type RouterClient,
  RouterUnavailableError,
} from "./motis.ts";

export function loadPlanFixture(name: string): PlanResponse {
  const path = fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url));
  const fixture = JSON.parse(readFileSync(path, "utf8")) as { response: unknown };
  return planResponseSchema.parse(fixture.response);
}

export interface RecordingClient extends RouterClient {
  readonly requests: PlanRequest[];
}

export function fixtureClient(plan: PlanResponse, healthy = true): RecordingClient {
  const requests: PlanRequest[] = [];
  return {
    requests,
    plan: async (request) => {
      requests.push(request);
      return plan;
    },
    health: async () => ({ ok: healthy, latencyMs: 3 }),
  };
}

/**
 * Answers each page cursor with its own recorded page; the first call has no cursor. A page that
 * was not recorded fails like a router that does not answer.
 */
export function pagedClient(pages: Readonly<Record<string, PlanResponse>>): RecordingClient {
  const requests: PlanRequest[] = [];
  return {
    requests,
    plan: async (request) => {
      requests.push(request);
      const page = pages[request.pageCursor ?? "first"];
      if (!page) {
        throw new RouterUnavailableError(`no recorded page for ${request.pageCursor}`);
      }
      return page;
    },
    health: async () => ({ ok: true, latencyMs: 3 }),
  };
}
