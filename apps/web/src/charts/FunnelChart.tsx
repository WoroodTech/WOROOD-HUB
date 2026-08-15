import type { FunnelPayload } from '../contract';
import { ordinalColor } from './palette';
import { formatInteger, formatPercent } from '../lib/format';

/**
 * Stages, not slices: an ordered ramp of one hue, each step labelled with its
 * own figure, its share of the top of the funnel, and the drop from the step
 * above. Drawn as bars rather than a tapering polygon so the lengths stay
 * readable.
 */
export function FunnelChart({ payload }: { payload: FunnelPayload }) {
  const steps = payload.steps ?? [];
  if (!steps.length) return <p className="chart-empty">No funnel data for this range.</p>;
  const top = steps[0]?.value || 1;

  return (
    <ol className="funnel">
      {steps.map((step, i) => {
        const share = (step.value / top) * 100;
        const prev = i > 0 ? steps[i - 1].value : null;
        const drop = prev && prev > 0 ? ((prev - step.value) / prev) * 100 : null;
        return (
          <li key={step.label} className="funnel__step">
            <div className="funnel__head">
              <span className="funnel__label">{step.label}</span>
              <span className="funnel__value">{formatInteger(step.value)}</span>
            </div>
            <div className="funnel__track">
              <div
                className="funnel__bar"
                style={{ inlineSize: `${Math.max(share, 0.6)}%`, background: ordinalColor(i, steps.length) }}
              />
            </div>
            <p className="funnel__meta">
              <span>{formatPercent(share, 1)} of sessions</span>
              {drop !== null ? <span className="funnel__drop">−{formatPercent(drop, 1)} from previous step</span> : null}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
