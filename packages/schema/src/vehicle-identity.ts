import { z } from "zod";
import { VehicleIdentity } from "./train-detail.ts";

/** The source id of layer L0: the unofficial bahn.de coach sequence (ADR-0011). */
export const VEHICLE_SEQUENCE_SOURCE = "bahn-vehicle-sequence";

/** Days of L0 results layer L1 takes its majority over (architecture section 9). */
export const MAJORITY_WINDOW_DAYS = 14;

/**
 * Confidence of each layer (architecture section 9): L0 fixed, L1 grows with the share and number
 * of agreeing observations, L2 falls with the number of series a line rule allows, L3 follows the
 * dominant series' share of the operator's fleet, L4 fixed.
 */
export const LAYER_CONFIDENCE = {
  L0: 0.97,
  L1: { min: 0.6, max: 0.95, fullAfter: 10 },
  L2: { single: 0.8, dominant: 0.5, floor: 0.3, spread: 0.9 },
  L3: { min: 0.3, max: 0.5 },
  L4: 0.1,
} as const;

const label = z.string().trim().min(1);
const catalogueId = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const shortLabel = label.max(40);

/** The identity the resolver chose, with the rule behind it and the other series that rule allows. */
export const VehicleResolution = VehicleIdentity.extend({
  ruleId: label.nullable(),
  alternatives: z.array(label),
});

/** One exact formation of a train on a service day, as layer L0 read it (table formation_observation). */
export const FormationObservation = z.object({
  sourceId: catalogueId,
  serviceDate: z.iso.date(),
  trainNumber: z.string().regex(/^\d{1,6}$/),
  operatorId: label.nullable(),
  categoryCode: label.nullable(),
  line: label.nullable(),
  seriesId: catalogueId,
  units: z.int().min(1).max(8).nullable(),
  cars: z.int().min(1).max(40).nullable(),
  lengthMetres: z.number().positive().lt(1000).nullable(),
  unitNames: z.array(shortLabel).max(16),
  sequenceStatus: shortLabel.nullable(),
  rawSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
});

export type VehicleResolution = z.infer<typeof VehicleResolution>;
export type FormationObservation = z.infer<typeof FormationObservation>;
