import { useCopy, useLocale } from "@gerlines/i18n/react";
import { Checkbox } from "@gerlines/ui";
import { useId } from "react";
import {
  hasNeutralMark,
  NEUTRAL_GROUP_SIZE,
  operatorColourCss,
} from "../../modes/operator-colours.ts";
import {
  groupName,
  isColouredGroup,
  OPERATOR_GROUPS,
  type OperatorGroup,
} from "../../modes/operator-groups.ts";
import { Count, ROW } from "./LegendDelayRows.tsx";

function OperatorRow({
  group,
  name,
  count,
  checked,
  onCheckedChange,
  separated = false,
}: {
  group: OperatorGroup;
  name: string;
  count: number | null;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  separated?: boolean;
}) {
  const locale = useLocale();
  const id = useId();
  return (
    <li
      data-slot="legend-row"
      data-operator-group={group}
      className={separated ? "mt-1 border-t border-hairline pt-1" : undefined}
    >
      <label
        htmlFor={id}
        className={`${ROW} group/row cursor-pointer grid-cols-[18px_14px_1fr_auto] rounded-md transition-colors hover:bg-raised has-[[data-unchecked]]:text-ink-muted`}
      >
        <span className="flex items-center">
          <Checkbox id={id} aria-label={name} checked={checked} onCheckedChange={onCheckedChange} />
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 14 14"
          width={14}
          height={14}
          className="group-has-[[data-unchecked]]/row:opacity-40"
        >
          <circle
            cx={7}
            cy={7}
            r={hasNeutralMark(group) ? 5 * NEUTRAL_GROUP_SIZE : 5}
            fill={operatorColourCss(group)}
          />
        </svg>
        <span lang={isColouredGroup(group) ? undefined : locale} className="min-w-0">
          {name}
        </span>
        <Count value={count} locale={locale} />
      </label>
    </li>
  );
}

export function OperatorRows({
  counts,
  hidden,
  onVisibleChange,
}: {
  counts: Readonly<Record<OperatorGroup, number>> | null;
  hidden: readonly OperatorGroup[];
  onVisibleChange: (group: OperatorGroup, visible: boolean) => void;
}) {
  const { operatorMode } = useCopy();
  const nameOf = (group: OperatorGroup) => {
    if (isColouredGroup(group)) return groupName(group);
    return group === "other" ? operatorMode.other : operatorMode.unknown;
  };
  const row = (group: OperatorGroup, separated = false) => (
    <OperatorRow
      key={group}
      separated={separated}
      group={group}
      name={nameOf(group)}
      count={counts ? counts[group] : null}
      checked={!hidden.includes(group)}
      onCheckedChange={(checked) => onVisibleChange(group, checked)}
    />
  );
  const coloured = OPERATOR_GROUPS.filter(isColouredGroup);
  return (
    <>
      <ul className="flex flex-col" data-testid="operator-legend" aria-label={operatorMode.label}>
        {coloured.map((group) => row(group))}
        {row("other", true)}
        {row("unknown")}
      </ul>
      <p className="type-caption mt-1 px-1 text-ink-muted">{operatorMode.hint}</p>
    </>
  );
}
