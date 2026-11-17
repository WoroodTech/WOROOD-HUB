import { useMemo } from 'react';
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CategoryPayload } from '../contract';
import { MAX_SERIES, OTHER_COLOR, chrome, seriesColor } from './palette';
import { formatPercent, formatValue, formatValueShort } from '../lib/format';

/*
 * A label with a capital at the front.
 *
 * Guarded because a label can be null: a grouping column that is nullable in
 * the database produces one, and the chart then took the whole dashboard
 * down with `null.charAt`. A row with nothing to call it is still a real
 * row with a real number, so it is named rather than dropped.
 */
const titleCase = (s: string | null | undefined) => {
  const t = String(s ?? '').trim();
  if (!t) return 'Not set';
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Donut for a part-to-whole split, horizontal bars for a ranked comparison.
 * Slots past the eighth fold into a single neutral "Other" -- a ninth series is
 * never a generated hue.
 */
export function CategoryChart({ payload, height = 240 }: { payload: CategoryPayload; height?: number }) {
  /*
   * Notes for the legend, when the payload carries them.
   *
   * "Manager" and "Finance" on a donut mean nothing until somebody has been
   * told what each desk does with a request — and the person reading the
   * dashboard is often exactly the person who has not.
   */
  const notes = (payload as { legend?: { label: string; note: string }[] }).legend;

  const c = chrome();
  const currency = payload.currency ?? 'EGP';

  const items = useMemo(() => {
    const sorted = [...payload.items].sort((a, b) => b.value - a.value);
    if (sorted.length <= MAX_SERIES) return sorted.map((it, i) => ({ ...it, color: seriesColor(i) }));
    const head = sorted.slice(0, MAX_SERIES - 1).map((it, i) => ({ ...it, color: seriesColor(i) }));
    const rest = sorted.slice(MAX_SERIES - 1);
    return [...head, {
      label: `Other (${rest.length})`,
      value: rest.reduce((a, b) => a + b.value, 0),
      secondary: null,
      color: OTHER_COLOR(),
    }];
  }, [payload.items]);

  const total = items.reduce((a, b) => a + (b.value || 0), 0);

  if (!items.length || total === 0) {
    return <p className="chart-empty">No activity to split for this range.</p>;
  }

  if (payload.kind === 'bar') {
  return (
      <div className="chart">
        <ResponsiveContainer width="100%" height={Math.max(height, items.length * 34)}>
          <BarChart data={items} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category" dataKey="label" width={130} tickLine={false} axisLine={false}
              tick={{ fill: c.ink, fontSize: 12 }} tickFormatter={titleCase}
            />
            <Tooltip
              cursor={{ fill: 'rgba(120,110,100,0.08)' }}
              content={({ active, payload: p }: any) => (active && p?.length ? (
                <div className="tip">
                  <p className="tip__head">{titleCase(p[0].payload.label)}</p>
                  <p className="tip__solo">{formatValue(p[0].value, payload.format, currency)}</p>
                </div>
              ) : null)}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
              {items.map((it) => <Cell key={it.label} fill={it.color} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }

  return (
    <div className="chart chart--donut">
      <div className="donut">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={items} dataKey="value" nameKey="label"
              innerRadius="62%" outerRadius="94%" paddingAngle={2} stroke={c.surface} strokeWidth={2}
              isAnimationActive={false}
            >
              {items.map((it) => <Cell key={it.label} fill={it.color} />)}
            </Pie>
            <Tooltip
              content={({ active, payload: p }: any) => (active && p?.length ? (
                <div className="tip">
                  <p className="tip__head">{titleCase(String(p[0].name))}</p>
                  <p className="tip__solo">
                    {formatValue(p[0].value, payload.format, currency)}
                    <span className="tip__muted"> · {formatPercent((p[0].value / total) * 100, 1)}</span>
                  </p>
                </div>
              ) : null)}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut__center">
          <span className="donut__total">{formatValueShort(total, payload.format, currency)}</span>
          <span className="donut__caption">total</span>
        </div>
      </div>

      {/* The legend carries label + value: identity is never colour alone, and
          it is the relief that the palette's lighter slots require. */}
      <ul className="legend legend--stack">
        {items.map((it) => (
          <li key={it.label} className="legend__row">
            <span className="legend__swatch" style={{ background: it.color }} aria-hidden="true" />
            <span className="legend__name">
              {titleCase(it.label)}
              {/* What this slice means, where the payload says. A label like
                  "Manager" is not self-explanatory to somebody who has not
                  been told what that desk does with a request. */}
              {notes?.find((n) => n.label === it.label)?.note ? (
                <small>{notes.find((n) => n.label === it.label)!.note}</small>
              ) : null}
            </span>
            <span className="legend__value">{formatValue(it.value, payload.format, currency)}</span>
            <span className="legend__share">{formatPercent((it.value / total) * 100, 1)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}