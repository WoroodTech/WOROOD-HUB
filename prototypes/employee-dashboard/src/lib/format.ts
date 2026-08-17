// Formatting helpers. Per section 7 of the Technical Design Document, all
// times render in the employee's own timezone (Principal.timezone).

export function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const time = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone }).format(d);
  const sameDay = start.toDateString() === end.toDateString();
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(
    start,
  );
  return sameDay ? `${day} · ${time(start)}–${time(end)}` : `${day} ${time(start)} → ${time(end)}`;
}

export function relativeFromNow(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60000);
  const abs = Math.abs(diffMin);
  const suffix = diffMin >= 0 ? 'from now' : 'ago';
  if (abs < 60) return `${abs} min ${suffix}`;
  const hours = Math.round(abs / 60);
  if (hours < 24) return `${hours} hr ${suffix}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ${suffix}`;
}

export function initialsColor(initials: string): string {
  const palette = ['#2f6f5e', '#3d5a99', '#8a5a2f', '#6a4c93', '#2f7a94'];
  const code = initials.charCodeAt(0) + (initials.charCodeAt(1) || 0);
  return palette[code % palette.length];
}
