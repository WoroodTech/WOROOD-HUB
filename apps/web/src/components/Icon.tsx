/**
 * Inline stroke icons. The navigation asks for icons by name (`icon` on the hub
 * response), so an unknown name must still render something sensible rather
 * than a hole in the sidebar.
 */

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16 16l4.5 4.5',
  calendar: 'M4 6.5h16v14H4zM4 10.5h16M8.5 3.5v4M15.5 3.5v4',
  'trending-up': 'M3.5 17 10 10.5l3.5 3.5L20.5 7M20.5 7h-5M20.5 7v5',
  receipt: 'M6 3.5h12v17l-3-1.6-3 1.6-3-1.6-3 1.6zM9 8.5h6M9 12.5h6',
  'layout-grid': 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  bell: 'M12 3.5a5.5 5.5 0 0 0-5.5 5.5c0 5-2 6.5-2 6.5h15s-2-1.5-2-6.5A5.5 5.5 0 0 0 12 3.5ZM10 19a2 2 0 0 0 4 0',
  users: 'M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 8.5a2.8 2.8 0 1 0 0-5.6M17 14.2c2.6.4 4.5 2.6 4.5 5.3',
  clock: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 7v5.3l3.4 2',
  door: 'M5 3.5h11v17H5zM13 12h.01M16 20.5h3',
  logout: 'M15 8V5.5H4.5v13H15V16M10 12h10m0 0-3-3m3 3-3 3',
  check: 'M4.5 12.5 9.5 17.5 19.5 6.5',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  up: 'M6 14.5 12 8.5l6 6',
  down: 'M6 9.5 12 15.5l6-6',
  left: 'M14.5 6 8.5 12l6 6',
  right: 'M9.5 6l6 6-6 6',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4',
  warning: 'M12 4 2.5 20.5h19zM12 10v4.5M12 17.5h.01',
  info: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 11v6M12 7.5h.01',
  lock: 'M6.5 10.5h11v9h-11zM9 10.5V7.5a3 3 0 0 1 6 0v3',
  database: 'M12 3.5c4.1 0 7 1.1 7 2.5S16.1 8.5 12 8.5 5 7.4 5 6s2.9-2.5 7-2.5ZM5 6v12c0 1.4 2.9 2.5 7 2.5s7-1.1 7-2.5V6',
  sparkles: 'M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9zM18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  dot: 'M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
};

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className }: IconProps) {
  const d = PATHS[name] ?? PATHS.dot;
  return (
    <svg
      className={className} width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

/** The mark in the sidebar: a stylised bloom, drawn rather than an asset. */
export function WoroodMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M16 4c3.6 2.6 5.4 5.7 5.4 9.3 0 3.6-1.8 6.7-5.4 9.3-3.6-2.6-5.4-5.7-5.4-9.3C10.6 9.7 12.4 6.6 16 4Z" />
        <path d="M16 22.6c2.9-2.4 6-3.3 9.3-2.6-1.4 3.1-3.8 5-7.3 5.7M16 22.6c-2.9-2.4-6-3.3-9.3-2.6 1.4 3.1 3.8 5 7.3 5.7" />
        <path d="M16 25.7V28" />
      </g>
    </svg>
  );
}
