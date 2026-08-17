// Minimal inline icon set — avoids pulling in an icon library dependency for
// what is, at this stage, a dozen glyphs. Swap for an icon package later if
// the icon count grows past what's comfortable to hand-maintain here.

const PATHS: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9',
  'calendar-plus': 'M4 8h16M6 4v4M18 4v4M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Zm7 7v4m-2-2h4',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-3a7.97 7.97 0 0 0-.2-1.8l2-1.6-2-3.4-2.4 1a8.1 8.1 0 0 0-3.1-1.8L14 2h-4l-.3 2.4a8.1 8.1 0 0 0-3.1 1.8l-2.4-1-2 3.4 2 1.6A7.97 7.97 0 0 0 4 12c0 .6.07 1.2.2 1.8l-2 1.6 2 3.4 2.4-1a8.1 8.1 0 0 0 3.1 1.8L10 22h4l.3-2.4a8.1 8.1 0 0 0 3.1-1.8l2.4 1 2-3.4-2-1.6c.13-.6.2-1.2.2-1.8Z',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m14.14 7.07 1.42 1.42M4.44 4.44l1.42 1.42m0 12.28-1.42 1.42M19.56 4.44l-1.42 1.42M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  'life-buoy':
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-5.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM5.6 5.6l3.2 3.2m6.4 6.4 3.2 3.2M18.4 5.6l-3.2 3.2M9 15.2l-3.2 3.2',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  bell: 'M6 8a6 6 0 1 1 12 0c0 4 1.5 5 1.5 5.5H4.5C4.5 13 6 12 6 8Zm4.5 9.5a1.5 1.5 0 0 0 3 0',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  chevron: 'm6 9 6 6 6-6',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-16v6l4 2',
  'map-pin': 'M12 22s7-7.5 7-12.5a7 7 0 1 0-14 0C5 14.5 12 22 12 22Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m19 0v-2a4 4 0 0 0-3-3.87M14 3.13a4 4 0 0 1 0 7.75M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  sparkles: 'M12 3v4m0 10v4M4 12h4m8 0h4M6.3 6.3l2.1 2.1m7.2 7.2 2.1 2.1M17.7 6.3l-2.1 2.1M8.4 15.6l-2.1 2.1',
  building: 'M4 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M14 21v-9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v9M8 8h.01M8 12h.01M8 16h.01',
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const d = PATHS[name] ?? PATHS.home;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
