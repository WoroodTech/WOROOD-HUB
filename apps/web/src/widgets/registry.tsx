/**
 * The widget registry is keyed by `payload.kind`, never by widget key.
 *
 * That is the whole point: the server can add `kpi-returns` or
 * `chart-refunds-trend` tomorrow, and the portal renders it correctly on the
 * first load, because it already knows how to draw a `kpi` and a `line`. A key
 * the portal has never heard of is not an error -- only a *shape* it has never
 * heard of is, and that falls back to a neutral placeholder.
 */

import type { ReactNode } from 'react';
import type {
  CategoryPayload, FunnelPayload, KpiPayload, SeriesPayload, TablePayload, WidgetPayload,
} from '../contract';
import { KpiTile } from '../charts/KpiTile';
import { SeriesChart } from '../charts/SeriesChart';
import { CategoryChart } from '../charts/CategoryChart';
import { FunnelChart } from '../charts/FunnelChart';
import { DataTable } from '../charts/DataTable';

export interface RenderContext {
  /** Categorical slot, so colour follows the widget's position, not its rank. */
  slot: number;
  currency: string;
  /** Rendered inside a full-width card? Charts get more height. */
  wide: boolean;
}

type Renderer = (payload: any, ctx: RenderContext) => ReactNode;

/** A `bar` envelope can be either shape: buckets over time (`series`) or a
 *  ranked comparison (`items`). The registry looks at the payload, not the key. */
const barRenderer: Renderer = (payload: SeriesPayload | CategoryPayload, ctx) => (
  'series' in payload
    ? <SeriesChart payload={payload} height={ctx.wide ? 280 : 220} />
    : <CategoryChart payload={payload} height={ctx.wide ? 280 : 220} />
);

export const WIDGET_RENDERERS: Record<string, Renderer> = {
  kpi: (payload: KpiPayload, ctx) => <KpiTile payload={payload} slot={ctx.slot} />,
  line: (payload: SeriesPayload, ctx) => <SeriesChart payload={payload} height={ctx.wide ? 300 : 220} />,
  bar: barRenderer,
  donut: (payload: CategoryPayload, ctx) => <CategoryChart payload={payload} height={ctx.wide ? 250 : 210} />,
  funnel: (payload: FunnelPayload) => <FunnelChart payload={payload} />,
  table: (payload: TablePayload, ctx) => <DataTable payload={payload} currency={ctx.currency} maxRows={12} />,
};

export const knowsKind = (kind: string): boolean => kind in WIDGET_RENDERERS;

export function renderWidget(payload: WidgetPayload, ctx: RenderContext): ReactNode {
  const renderer = WIDGET_RENDERERS[payload.kind];
  return renderer ? renderer(payload, ctx) : null;
}

/** KPIs are tiles; everything else is a panel with a header. */
export const isTile = (payload: WidgetPayload | null | undefined) => payload?.kind === 'kpi';
