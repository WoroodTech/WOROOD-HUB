import { useId } from 'react';
import { seriesColor } from './palette';

/**
 * A trend shape, not a chart: no axes, no labels, no tooltip. It sits beside a
 * figure that already carries the number.
 */
export function Sparkline({ points, colorSlot = 0, height = 34, label }: {
  points: number[];
  colorSlot?: number;
  height?: number;
  label?: string;
}) {
  const id = useId();
  if (!points || points.length < 2) return null;

  const w = 100, h = height;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 6);
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  const color = seriesColor(colorSlot);

  return (
    <svg
      className="sparkline" viewBox={`0 0 ${w} ${h}`} height={h} preserveAspectRatio="none"
      role="img" aria-label={label ?? 'Trend for the period'}
    >
      <title>{`${label ?? 'Trend'} — the recent buckets supplied with this figure`}</title>
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
