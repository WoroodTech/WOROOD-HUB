import { Icon } from '../Icon';
import type { HubModule } from '../../lib/types';

// Surfaces every not-yet-built module registered in the hub descriptor
// (Technical Design §3.4 — Leave Requests, Help Desk, Document Library, …)
// so employees can see the roadmap without anything being hard-coded here.
export function ComingSoonStrip({ modules }: { modules: HubModule[] }) {
  const upcoming = modules.filter((m) => m.comingSoon);
  if (upcoming.length === 0) return null;

  return (
    <div className="wh-portlet">
      <div className="wh-portlet__header">
        <span className="wh-portlet__title">More on the way</span>
      </div>
      <div className="wh-portlet__body">
        <div className="wh-coming-soon-strip">
          {upcoming.map((m) => (
            <span className="wh-coming-soon-chip" key={m.key}>
              <Icon name={m.navigation[0]?.icon ?? 'sparkles'} size={14} />
              {m.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
