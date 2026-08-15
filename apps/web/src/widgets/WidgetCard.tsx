import type { WidgetEnvelope } from '../contract';
import { Card, DataAge } from '../components/Card';
import { ErrorState, PlaceholderState } from '../components/States';
import { isTile, knowsKind, renderWidget } from './registry';

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
        actions={<DataAge seconds={dataAgeSeconds} generatedAt={generatedAt} stale={stale} />}
      >
        {body}
      </Card>
    </div>
  );
}
