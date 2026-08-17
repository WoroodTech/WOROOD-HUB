import { Icon } from '../Icon';
import { initialsColor } from '../../lib/format';
import type { Principal } from '../../lib/types';

export function ProfileCard({ principal }: { principal: Principal }) {
  return (
    <div className="wh-profile-card">
      <div className="wh-avatar wh-profile-card__avatar" style={{ background: initialsColor(principal.avatarInitials) }}>
        {principal.avatarInitials}
      </div>
      <div style={{ flex: 1 }}>
        <div className="wh-profile-card__name">{principal.fullName}</div>
        <div className="wh-profile-card__meta">
          {principal.jobTitle} · {principal.department}
        </div>
        <div className="wh-profile-card__tags">
          <span className="wh-tag">
            <Icon name="map-pin" size={12} /> {principal.locationName}
          </span>
          {principal.roles.map((r) => (
            <span className="wh-tag" key={r} style={{ textTransform: 'capitalize' }}>
              {r}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
