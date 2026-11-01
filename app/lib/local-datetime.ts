/** Formats a Date as the value of an `<input type="datetime-local">` in the browser's time zone. */
export function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Same wall-clock time `days` calendar days later. Adding 24 h per day instead would land an hour off when the
 * clocks change in between (daylight saving), e.g. a 14:00 start getting a 13:00 or 15:00 end.
 */
export function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

/** Default end for a start typed into a datetime-local input; null if the start isn't a valid date yet. */
export function defaultEndFor(startLocalInput: string, days: number): string | null {
  if (!startLocalInput) return null;
  const start = new Date(startLocalInput);
  if (Number.isNaN(start.getTime())) return null;
  return toLocalInput(addLocalDays(start, days));
}
