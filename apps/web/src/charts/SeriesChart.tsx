import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, ComposedChart, Line, ReferenceArea,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { SeriesPayload } from '../contract';
import { chrome, seriesColor } from './palette';
import { formatDayMonth, formatMonth, formatValue, formatValueShort } from '../lib/format';

type Fmt = 'money' | 'integer' | 'percent';

interface Row { t: string; label: string; provisional: boolean; [key: string]: string | number | boolean }

const bucketLabel = (iso: string, span: number) =>
  (span > 200 ? formatMonth(iso) : formatDayMonth(iso));

function TooltipCard({ active, payload, currency, formats }: any) {
  if (!active || !payload?.length) return null;
  const row: Row = payload[0].payload;
  return (
    <div className="tip">
      <p className="tip__head">
        {row.label}
        {row.provisional ? <span className="tip__flag">provisional</span> : null}
      </p>
      <ul className="tip__list">
        {payload.map((p: any) => (
          <li key={p.dataKey}>
            <span className="tip__swatch" style={{ background: p.color }} aria-hidden="true" />
            <span className="tip__name">{p.name}</span>
            <span className="tip__value">
              {formatValue(p.value, formats[p.dataKey] ?? 'integer', currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Line and time-bucketed bar charts. One y-axis, always: two measures of
 * different scale get two charts, never a second axis.
 */
export function SeriesChart({ payload, height = 260, slotOffset = 0 }: {
  payload: SeriesPayload; height?: number; slotOffset?: number;
}) {
  // Two measures on different scales (sessions and a conversion percentage, say)
  // never share a y-axis. They become small multiples: one chart each, one axis
  // each, stacked so the time axis still lines up.
  const distinctFormats = new Set(payload.series.map((s) => s.format ?? payload.format));
  if (payload.series.length > 1 && distinctFormats.size > 1) {
    return (
      <div className="facets">
        {payload.series.map((s, i) => (
          <div className="facet" key={s.key}>
            <p className="facet__title">
              <span className="legend__swatch" style={{ background: seriesColor(i) }} aria-hidden="true" />
              {s.label}
            </p>
            <OneAxisChart
              payload={{ ...payload, format: (s.format ?? payload.format), series: [s] }}
              height={Math.max(140, Math.round(height / payload.series.length))}
              slotOffset={i}
            />
          </div>
        ))}
      </div>
    );
  }
  return <OneAxisChart payload={payload} height={height} slotOffset={slotOffset} />;
}

/** One dataset, one y-axis. Never rendered with mixed-format series. */
function OneAxisChart({ payload, height, slotOffset }: {
  payload: SeriesPayload; height: number; slotOffset: number;
}) {
  const c = chrome();
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const { rows, series, formats, provisionalFrom } = useMemo(() => {
    const stamps = new Set<string>();
    payload.series.forEach((s) => s.points.forEach((p) => stamps.add(p.t)));
    const sorted = [...stamps].sort();
    const provFrom = payload.provisionalFrom ? new Date(payload.provisionalFrom).getTime() : null;
    const rows: Row[] = sorted.map((t) => {
      const row: Row = {
        t,
        label: bucketLabel(t, sorted.length),
        provisional: provFrom !== null && new Date(t).getTime() >= provFrom,
      };
      payload.series.forEach((s) => {
        const hit = s.points.find((p) => p.t === t);
        row[s.key] = hit ? hit.v : (null as unknown as number);
      });
      return row;
    });
    const formats: Record<string, Fmt> = {};
    payload.series.forEach((s) => { formats[s.key] = (s.format ?? payload.format) as Fmt; });
    return { rows, series: payload.series, formats, provisionalFrom: provFrom };
  }, [payload]);

  if (!rows.length) {
    return (
      <p className="chart-empty">
        Nothing in this range yet. The buckets for this period are still empty.
      </p>
    );
  }

  const visible = series.filter((s) => !hidden.has(s.key));
  const primaryFormat = (visible[0] ? formats[visible[0].key] : payload.format) as Fmt;
  const currency = payload.currency ?? 'EGP';
  const provRow = provisionalFrom !== null ? rows.find((r) => r.provisional) : undefined;

  const toggle = (key: string) => setHidden((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key);
    else if (prev.size < series.length - 1) next.add(key);
    return next;
  });

  const isBar = payload.kind === 'bar';
  const Chart: any = isBar ? BarChart : ComposedChart;

  return (
    <div className="chart">
      {series.length > 1 ? (
        <ul className="legend">
          {series.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                className={`legend__item${hidden.has(s.key) ? ' legend__item--off' : ''}`}
                onClick={() => toggle(s.key)}
                aria-pressed={!hidden.has(s.key)}
              >
                <span className="legend__swatch" style={{ background: seriesColor(i + slotOffset) }} aria-hidden="true" />
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <ResponsiveContainer width="100%" height={height}>
        <Chart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="label" tickLine={false} axisLine={{ stroke: c.axis }}
            tick={{ fill: c.muted, fontSize: 11 }} minTickGap={24} interval="preserveStartEnd"
          />
          <YAxis
            tickLine={false} axisLine={false} width={76}
            tick={{ fill: c.muted, fontSize: 11 }}
            tickFormatter={(v: number) => formatValueShort(v, primaryFormat, currency)}
          />
          <Tooltip
            cursor={{ stroke: c.axis, strokeWidth: 1, fill: isBar ? 'rgba(120,110,100,0.08)' : undefined }}
            content={<TooltipCard currency={currency} formats={formats} />}
          />
          {provRow ? (
            <ReferenceArea
              x1={provRow.label} x2={rows[rows.length - 1].label}
              fill={c.muted} fillOpacity={0.08} stroke="none"
            />
          ) : null}
          {series.map((s, i) => (
            hidden.has(s.key) ? null : isBar ? (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={seriesColor(i + slotOffset)}
                   radius={[4, 4, 0, 0]} maxBarSize={26} isAnimationActive={false} />
            ) : (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label}
                    stroke={seriesColor(i + slotOffset)} strokeWidth={2} dot={false} connectNulls isAnimationActive={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: c.surface }} />
            )
          ))}
        </Chart>
      </ResponsiveContainer>

      {provRow ? (
        <p className="chart-note">
          The shaded bucket is still open, so its figure is provisional and will keep moving.
        </p>
      ) : null}
    </div>
  );
}
