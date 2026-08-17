/**
 * The home screen.
 *
 * It is composed, not authored: the server says which portlets this employee
 * has, and this page arranges them. Two portlets are the portal's own rather
 * than a module's -- Quick actions and What's coming -- and even those are
 * derived from the module descriptors, so a new module appears in both without
 * anyone editing this file.
 *
 * Arrangement is the employee's: order, width and folded-away state are theirs
 * to set and are remembered per user. Permission is not -- a portlet they may
 * not see never reaches the browser, so there is nothing here to enforce.
 */

import { useMemo, useState } from 'react';
import { useHubModules } from '../lib/hub';
import { useAuth } from '../lib/auth';
import { useHomeLayout, type PortletSeed } from '../lib/layout';
import { useToast } from '../lib/toast';
import { PORTLET_REGISTRY, UnknownPortlet, LOCAL_PORTLETS } from '../portlets/registry';
import { ProfileBanner } from '../portlets/ProfileBanner';
import { LoadingState, ErrorState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDate } from '../lib/format';

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', hour: '2-digit', hour12: false,
  }).format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function Home() {
  const { principal } = useAuth();
  const { data, isPending, error, refetch } = useHubModules();
  const toast = useToast();
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const firstName = principal?.fullName?.split(' ')[0] ?? '';

  /* Server portlets, plus the two the portal contributes itself. The local
     ones are pinned to the tail by their order so a granted module portlet
     always outranks them on a first visit. */
  const seeds = useMemo<PortletSeed[]>(() => {
    const fromServer = (data?.dashboard ?? []).map((p) => ({
      key: p.key, width: p.width, order: p.order,
    }));
    const local = LOCAL_PORTLETS.map((p, i) => ({ key: p.key, width: p.width, order: 900 + i }));
    return [...fromServer, ...local];
  }, [data]);

  const layout = useHomeLayout(principal?.id ?? '', seeds);
  const { customising, setCustomising, visible, hidden } = layout;

  const metaOf = useMemo(() => {
    const map = new Map<string, { moduleKey: string; title: string }>();
    for (const p of data?.dashboard ?? []) map.set(p.key, { moduleKey: p.moduleKey, title: p.title });
    for (const p of LOCAL_PORTLETS) map.set(p.key, { moduleKey: 'hub', title: p.title });
    return map;
  }, [data]);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">{greeting()}, {firstName}</h1>
          <p className="pagehead__sub">
            {principal?.jobTitle ? `${principal.jobTitle} · ` : ''}
            {principal?.department ? `${principal.department} · ` : ''}
            {formatDate(new Date().toISOString())} in Cairo
          </p>
        </div>

        {seeds.length ? (
          <div className="pagehead__tools">
            <button
              type="button"
              className={`btn btn--sm${customising ? ' btn--primary' : ' btn--ghost'}`}
              onClick={() => setCustomising(!customising)}
              aria-pressed={customising}
            >
              <Icon name="sliders" size={15} />
              <span className="btn__label">{customising ? 'Done' : 'Customise'}</span>
            </button>
            {customising && !layout.isDefault ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => { layout.reset(); toast.push('Home screen restored to its default layout.', 'good'); }}
              >
                <Icon name="refresh" size={15} />
                <span className="btn__label">Reset</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      <ProfileBanner />

      {customising ? (
        <p className="notice notice--tip">
          <Icon name="grip" size={15} />
          <span>
            Drag a card by its handle to reorder, or use the arrows. <strong>Wider</strong> and{' '}
            <strong>narrower</strong> change how much of the row a card takes; <strong>hide</strong> folds
            it away without losing it. Only you see this arrangement.
          </span>
        </p>
      ) : null}

      {isPending ? <LoadingState label="Loading your home screen" lines={4} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      <div className={`grid${customising ? ' grid--customising' : ''}`}>
        {visible.map((entry, index) => {
          const meta = metaOf.get(entry.key);
          const Component = PORTLET_REGISTRY[entry.key] ?? UnknownPortlet;
          return (
            <div
              className={[
                'grid__cell',
                dragging === entry.key ? 'is-dragging' : '',
                over === entry.key && dragging && dragging !== entry.key ? 'is-over' : '',
              ].filter(Boolean).join(' ')}
              key={entry.key}
              style={{ ['--span' as string]: String(entry.width) }}
              draggable={customising}
              onDragStart={(e) => { setDragging(entry.key); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setDragging(null); setOver(null); }}
              onDragOver={(e) => { if (customising && dragging) { e.preventDefault(); setOver(entry.key); } }}
              onDragLeave={() => setOver((k) => (k === entry.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragging) layout.move(dragging, entry.key);
                setDragging(null);
                setOver(null);
              }}
            >
              {customising ? (
                <div className="cellbar">
                  <span className="cellbar__grip" aria-hidden="true"><Icon name="grip" size={14} /></span>
                  <span className="cellbar__name">{meta?.title ?? entry.key}</span>
                  <span className="cellbar__group">
                    <button type="button" className="iconbtn iconbtn--xs" title="Move earlier"
                            disabled={index === 0} onClick={() => layout.nudge(entry.key, -1)}>
                      <Icon name="left" size={13} /><span className="visually-hidden">Move earlier</span>
                    </button>
                    <button type="button" className="iconbtn iconbtn--xs" title="Move later"
                            disabled={index === visible.length - 1} onClick={() => layout.nudge(entry.key, 1)}>
                      <Icon name="right" size={13} /><span className="visually-hidden">Move later</span>
                    </button>
                    <button type="button" className="iconbtn iconbtn--xs" title="Narrower"
                            disabled={entry.width <= 4} onClick={() => layout.resize(entry.key, -1)}>
                      <Icon name="shrink" size={13} /><span className="visually-hidden">Narrower</span>
                    </button>
                    <button type="button" className="iconbtn iconbtn--xs" title="Wider"
                            disabled={entry.width >= 12} onClick={() => layout.resize(entry.key, 1)}>
                      <Icon name="expand" size={13} /><span className="visually-hidden">Wider</span>
                    </button>
                    <button type="button" className="iconbtn iconbtn--xs" title="Hide this card"
                            onClick={() => {
                              layout.toggleHidden(entry.key);
                              toast.push(`"${meta?.title ?? entry.key}" hidden. Unhide it from the tray below.`);
                            }}>
                      <Icon name="eye-off" size={13} /><span className="visually-hidden">Hide</span>
                    </button>
                  </span>
                </div>
              ) : null}

              <Component
                moduleKey={meta?.moduleKey ?? 'hub'}
                portletKey={entry.key}
                title={meta?.title ?? entry.key}
              />
            </div>
          );
        })}
      </div>

      {customising && hidden.length ? (
        <section className="tray">
          <h2 className="tray__title">Hidden cards</h2>
          <ul className="tray__list">
            {hidden.map((entry) => (
              <li key={entry.key}>
                <button type="button" className="chipbtn" onClick={() => {
                  layout.toggleHidden(entry.key);
                  toast.push(`"${metaOf.get(entry.key)?.title ?? entry.key}" is back on your home screen.`, 'good');
                }}>
                  <Icon name="eye" size={14} />
                  {metaOf.get(entry.key)?.title ?? entry.key}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
