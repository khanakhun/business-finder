// The next business day at 10:00 in a time zone (BF-048: a lead's call-back task is due then). Pure.

/** 10:00 local time on the next weekday (Mon–Fri) after `now`, in `timeZone`, as a UTC instant. */
export function nextBusinessMorning(now: Date, timeZone: string): Date {
  const parts = (date: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    ) as Record<string, string>;
  let day = new Date(now.getTime() + 86_400_000);
  for (let i = 0; i < 7; i++) {
    const weekday = parts(day).weekday;
    if (weekday !== 'Sat' && weekday !== 'Sun') break;
    day = new Date(day.getTime() + 86_400_000);
  }
  const local = parts(day);
  // The UTC instant of 10:00 that day in the zone: start from 10:00 UTC and correct by the zone's offset then.
  const guess = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), 10, 0);
  const shown = parts(new Date(guess));
  const offset =
    Date.UTC(
      Number(shown.year),
      Number(shown.month) - 1,
      Number(shown.day),
      Number(shown.hour),
      Number(shown.minute),
    ) - guess;
  return new Date(guess - offset);
}
