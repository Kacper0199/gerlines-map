import { COLOURED_GROUPS, type ColouredGroup } from "./operator-group-list.ts";
import { OPERATOR_GROUP_TABLE } from "./operator-groups.generated.ts";

export { COLOURED_GROUPS, type ColouredGroup };

export type OperatorGroup = ColouredGroup | "other" | "unknown";

export const OPERATOR_GROUPS: readonly OperatorGroup[] = [
  ...COLOURED_GROUPS.map((group) => group.id),
  "other",
  "unknown",
];

export function isOperatorGroup(value: unknown): value is OperatorGroup {
  return OPERATOR_GROUPS.includes(value as OperatorGroup);
}

export function isColouredGroup(group: OperatorGroup): group is ColouredGroup {
  return group !== "other" && group !== "unknown";
}

/** Later groups are drawn over earlier ones: the many Deutsche Bahn trains sit below the smaller groups. */
export const OPERATOR_DRAW_ORDER: Readonly<Record<OperatorGroup, number>> = Object.fromEntries([
  ["unknown", 0],
  ["other", 1],
  ...COLOURED_GROUPS.map((group, index) => [group.id, index + 2]),
]) as Record<OperatorGroup, number>;

/**
 * The group of a train from the catalogue operator id its frame carries. A train without an operator, or
 * with one the catalogue does not list, is `unknown`, never `other`.
 */
export function operatorGroupOf(operatorId: string | null | undefined): OperatorGroup {
  if (operatorId === null || operatorId === undefined) return "unknown";
  return Object.hasOwn(OPERATOR_GROUP_TABLE, operatorId)
    ? (OPERATOR_GROUP_TABLE[operatorId] as OperatorGroup)
    : "unknown";
}

export function groupName(group: ColouredGroup): string {
  return COLOURED_GROUPS.find((entry) => entry.id === group)?.name ?? group;
}
