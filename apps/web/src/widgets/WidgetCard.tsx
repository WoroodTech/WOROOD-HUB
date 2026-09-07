import type { WidgetEnvelope } from '../contract';
import { Card, DataAge } from '../components/Card';
import { ErrorState, PlaceholderState } from '../components/States';
import { isTile, knowsKind, renderWidget } from './registry';
import { Icon } from '../components/Icon';

export function WidgetCard({ envelope, width, slot, currency, stale }: {
  envelope: WidgetEnvelope;
  width: number;
  slot: number;
  currency: string;
  stale: boolean;
}) {
  const { payload, error, title, generatedAt, dataAgeSeconds } = envelope;
  const wide = width >= 8;

  // A KPI is a bare tile: the figure is the whole widget, so a card header
  // above it would just say the same thing twice.
  if (isTile(payload) && !error) {
    return (
      <div className="grid__cell tile" style={{ ['--span' as string]: String(width) }}>
        {renderWidget(payload!, { slot, currency, wide })}
      </div>
    );
  }

  let body;
  if (error) {
    body = <ErrorState error={new Error(error)} compact />;
  } else if (!payload) {
    body = <ErrorState error={new Error('This widget returned no data for the selected range.')} compact />;
  } else if (!knowsKind(payload.kind)) {
    body = (
      <PlaceholderState
        label={`Unsupported widget shape: ${payload.kind}`}
        hint="The API sent a payload shape this portal build cannot draw. Everything else on the dashboard is unaffected."
      />
    );
  } else {
    body = renderWidget(payload, { slot, currency, wide });
  }

  return (
    <div className="grid__cell" style={{ ['--span' as string]: String(width) }}>
      <Card
        title={title}
        actions={
          <span className="card__actionrow">
            {/* Says where the number came from, because these two kinds of
                figure cannot be checked the same way. Everything read from
                ShopifyQL can be held against a Shopify admin report line for
                line; a cohort retention percentage cannot, because Shopify does
                not publish one. Marking it is the difference between a reader
                who knows to expect a small divergence and one who finds it and
                stops trusting the whole screen. */}
       
            <DataAge seconds={dataAgeSeconds} generatedAt={generatedAt} stale={stale} />
          </span>
        }
      >
        {body}
      </Card>
    </div>
  );
}