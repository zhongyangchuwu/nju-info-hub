const YEAR_FIRST_DATE_PARTS_RE =
  /^(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/;
const MONTH_FIRST_DATE_PARTS_RE = /^(\d{1,2})[-/.](\d{1,2})\s+(20\d{2})$/;

/** Returns a calendar date, not a timestamp or an inferred timezone. */
export function normalizePublicationDate(value: string | undefined | null): string | null {
  if (value == null) return null;
  const yearFirst = value.match(YEAR_FIRST_DATE_PARTS_RE);
  const monthFirst = value.match(MONTH_FIRST_DATE_PARTS_RE);
  if (!yearFirst && !monthFirst) return null;

  const year = Number(yearFirst?.[1] ?? monthFirst?.[3]);
  const month = Number(yearFirst?.[2] ?? monthFirst?.[1]);
  const day = Number(yearFirst?.[3] ?? monthFirst?.[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
