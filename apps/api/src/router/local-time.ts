const DAY_MS = 86_400_000;

function localDate(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(ms);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function offsetText(ms: number, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(ms)
    .find((part) => part.type === "timeZoneName")?.value;
  const offset = name?.replace("GMT", "") ?? "";
  return offset === "" ? "+00:00" : offset;
}

const pad = (value: number) => String(value).padStart(2, "0");

export function nextWeekdayAt(
  nowMs: number,
  isoWeekday: number,
  hour: number,
  timeZone: string,
): string {
  const today = localDate(nowMs, timeZone);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const todayWeekday = new Date(todayUtc).getUTCDay() || 7;
  const daysAhead = ((isoWeekday - todayWeekday + 6) % 7) + 1;
  const target = new Date(todayUtc + daysAhead * DAY_MS);
  const wallClockAsUtc = Date.UTC(
    target.getUTCFullYear(),
    target.getUTCMonth(),
    target.getUTCDate(),
    hour,
  );
  const date = `${target.getUTCFullYear()}-${pad(target.getUTCMonth() + 1)}-${pad(target.getUTCDate())}`;
  return `${date}T${pad(hour)}:00:00${offsetText(wallClockAsUtc, timeZone)}`;
}
