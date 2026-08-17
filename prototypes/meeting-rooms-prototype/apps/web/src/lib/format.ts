/** Everything the portal renders is shown in the employee's own timezone. */

let displayTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function setDisplayTimezone(timezone: string | undefined) {
  if (timezone) displayTimezone = timezone;
}

export function getDisplayTimezone() {
  return displayTimezone;
}

const timeFmt = () =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: displayTimezone,
  });

const dateFmt = () =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: displayTimezone,
  });

const longDateFmt = () =>
  new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: displayTimezone,
  });

export const formatTime = (iso: string) => timeFmt().format(new Date(iso));
export const formatDate = (iso: string) => dateFmt().format(new Date(iso));
export const formatLongDate = (iso: string) => longDateFmt().format(new Date(iso));
export const formatDateTime = (iso: string) => `${formatDate(iso)}, ${formatTime(iso)}`;

export const formatRange = (from: string, to: string) => `${formatTime(from)} – ${formatTime(to)}`;

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** "in 2 hours", "tomorrow", "3 days ago" — for the dashboard portlets. */
export function relativeToNow(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const minutes = Math.round(diffMs / 60_000);

  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

/** Today's date as YYYY-MM-DD in the display timezone. */
export function todayIso(offsetDays = 0): string {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: displayTimezone }).format(now);
}

/**
 * Current wall-clock time as HH:mm in the display timezone.
 * The API interprets a submitted start time in the room's local timezone, so
 * the portal must reason in the same clock rather than the browser's.
 */
export function nowTimeIso(): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: displayTimezone,
  }).format(new Date());
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}
