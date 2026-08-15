import type { KpiPayload } from '../contract';
import { Sparkline } from './Sparkline';
import { Delta } from '../components/Delta';
import { ProvisionalTag } from '../components/Card';
import { formatInteger, formatMoney, formatMoneyShort, formatPercent } from '../lib/format';

const INVERTED = /outstanding|discount|refund/i;

/**
 * One figure, said once. Tiles may abbreviate; the exact value is always in the
 * `title`, so a reader who needs the precise number can get it without leaving
 * the page.
 */
export function KpiTile({ payload, slot = 0, title }: { payload: KpiPayload; slot?: number; title?: string }) {
  const currency = payload.currency ?? 'EGP';
  const label = title ?? payload.label;

  const exact = payload.format === 'money' ? formatMoney(payload.value, currency)
    : payload.format === 'percent' ? formatPercent(payload.value)
      : formatInteger(payload.value);
  const shown = payload.format === 'money' ? formatMoneyShort(payload.value, currency) : exact;

  return (
    <div className="kpi">
      <div className="kpi__top">
        <p className="kpi__label">{label}</p>
        {payload.provisional ? <ProvisionalTag what="figure" /> : null}
      </div>
      <p className="kpi__value" title={exact}>{shown}</p>
      <div className="kpi__foot">
        <Delta
          value={payload.value}
          comparedTo={payload.comparedTo}
          label={payload.comparisonLabel}
          invert={INVERTED.test(label)}
        />
      </div>
      {payload.sparkline?.length ? (
        <Sparkline points={payload.sparkline} colorSlot={slot} label={`${label} trend`} />
      ) : null}
    </div>
  );
}
