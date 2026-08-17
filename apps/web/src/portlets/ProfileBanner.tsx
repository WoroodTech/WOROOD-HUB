/**
 * The identity strip at the top of the home screen.
 *
 * It answers "who does the portal think I am, and what am I allowed to do" in
 * one glance -- which matters in a portal where the grid changes shape from one
 * account to the next. It is not a portlet: it never moves, never hides, and
 * carries no data of its own beyond the session.
 */

import { useAuth } from '../lib/auth';
import { useAppearance } from '../lib/theme';
import { Icon } from '../components/Icon';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
}

export function ProfileBanner() {
  const { principal } = useAuth();
  const { locale } = useAppearance();
  if (!principal) return null;

  /* The Arabic name is the person's name, not a translation -- show it when
     the portal is in Arabic, and keep the Latin one as the second line. */
  const primary = locale === 'ar' && principal.fullNameAr ? principal.fullNameAr : principal.fullName;
  const secondary = locale === 'ar' && principal.fullNameAr ? principal.fullName : null;

  return (
    <section className="profile" aria-label="Your account">
      <span className="profile__avatar" aria-hidden="true">{initials(principal.fullName)}</span>

      <div className="profile__body">
        <p className="profile__name">
          {primary}
          {secondary ? <span className="profile__alt">{secondary}</span> : null}
        </p>
        <p className="profile__meta">
          {[principal.jobTitle, principal.department].filter(Boolean).join(' · ') || principal.email}
        </p>
      </div>

      <ul className="profile__tags">
        <li className="idtag"><Icon name="map-pin" size={12} /> {principal.timezone.split('/').pop()?.replace(/_/g, ' ')}</li>
        {principal.roles.map((role) => (
          <li className="idtag idtag--role" key={role}>
            <Icon name="user" size={12} /> {role.replace(/-/g, ' ')}
          </li>
        ))}
      </ul>
    </section>
  );
}
