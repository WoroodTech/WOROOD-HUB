import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DashboardAccessResponse, DashboardDetail, DashboardSummary, WidgetDefinition,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { Badge } from '../components/Card';
import { ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { Link } from 'react-router-dom';

interface Placement { widgetKey: string; width: number }

const WIDTHS = [3, 4, 6, 8, 12];

/** The data an area comes from is the honest grouping for the catalogue: it is
 *  what makes a "combined" dashboard nothing more than picking from two lists. */
const AREA_LABEL: Record<string, string> = {
  'sales.snapshot': 'Sales',
  'orders.mirror': 'Orders and cash',
  'sessions.snapshot': 'Sessions and conversion',
  'traffic.snapshot': 'Traffic',
};
const areaOf = (w: WidgetDefinition) => AREA_LABEL[w.dataSource] ?? w.dataSource;

export function Composer() {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tab, setTab] = useState<'layout' | 'access'>('layout');
  const [layout, setLayout] = useState<Placement[]>([]);
  const [dirty, setDirty] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const dashboards = useQuery({
    queryKey: qk.dashboards,
    queryFn: () => api<DashboardSummary[]>('/sales/dashboards'),
  });

  const catalogue = useQuery({
    queryKey: qk.widgets,
    queryFn: () => api<{ widgets: WidgetDefinition[] }>('/sales/widgets'),
    staleTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (!selectedKey && dashboards.data?.length) setSelectedKey(dashboards.data[0].key);
  }, [dashboards.data, selectedKey]);

  const detail = useQuery({
    queryKey: qk.dashboard(selectedKey ?? ''),
    queryFn: () => api<DashboardDetail>(`/sales/dashboards/${selectedKey}`),
    enabled: !!selectedKey,
  });

  useEffect(() => {
    if (detail.data) {
      setLayout(detail.data.widgets
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((w) => ({ widgetKey: w.widgetKey, width: w.width })));
      setDirty(false);
    }
  }, [detail.data]);

  const byKey = useMemo(() => {
    const map = new Map<string, WidgetDefinition>();
    catalogue.data?.widgets.forEach((w) => map.set(w.key, w));
    return map;
  }, [catalogue.data]);

  const grouped = useMemo(() => {
    const groups = new Map<string, WidgetDefinition[]>();
    (catalogue.data?.widgets ?? []).forEach((w) => {
      const area = areaOf(w);
      if (!groups.has(area)) groups.set(area, []);
      groups.get(area)!.push(w);
    });
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalogue.data]);

  const areasInLayout = useMemo(() => {
    const set = new Set<string>();
    layout.forEach((p) => { const def = byKey.get(p.widgetKey); if (def) set.add(areaOf(def)); });
    return [...set];
  }, [layout, byKey]);

  const dashboardId = detail.data?.id;

  const saveLayout = useMutation({
    mutationFn: () => api(`/sales/dashboards/${dashboardId}/widgets`, {
      method: 'PUT',
      body: { widgets: layout.map((p) => ({ widgetKey: p.widgetKey, width: p.width })) },
    }),
    onSuccess: async () => {
      setDirty(false);
      setFlash('Layout saved.');
      await queryClient.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  const createDashboard = useMutation({
    mutationFn: (body: { key: string; name: string; description?: string }) =>
      api<{ key: string }>('/sales/dashboards', { method: 'POST', body }),
    onSuccess: async (created) => {
      setCreating(false);
      setFlash(`Dashboard "${created.key}" created. It starts empty — add widgets on the right.`);
      await queryClient.invalidateQueries({ queryKey: qk.dashboards });
      setSelectedKey(created.key);
      setTab('layout');
    },
  });

  const add = (widget: WidgetDefinition) => {
    setLayout((prev) => [...prev, { widgetKey: widget.key, width: widget.defaultWidth }]);
    setDirty(true);
    setFlash(null);
  };
  const removeAt = (i: number) => { setLayout((p) => p.filter((_, idx) => idx !== i)); setDirty(true); };
  const move = (i: number, by: number) => setLayout((prev) => {
    const next = [...prev];
    const target = i + by;
    if (target < 0 || target >= next.length) return prev;
    [next[i], next[target]] = [next[target], next[i]];
    setDirty(true);
    return next;
  });
  const setWidth = (i: number, width: number) => setLayout((prev) => {
    const next = [...prev];
    next[i] = { ...next[i], width };
    setDirty(true);
    return next;
  });

  const selected = dashboards.data?.find((d) => d.key === selectedKey);

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Dashboard composer</h1>
          <p className="pagehead__sub">
            Pick widgets, order them, choose widths, decide who sees the result. Widgets are the unit of reuse:
            a “combined” dashboard is simply one whose picks come from more than one area.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={() => setCreating((v) => !v)}>
          <Icon name="plus" size={16} /> New dashboard
        </button>
      </header>

      {creating ? (
        <CreateForm
          busy={createDashboard.isPending}
          error={createDashboard.error}
          onCancel={() => setCreating(false)}
          onSubmit={(body) => createDashboard.mutate(body)}
        />
      ) : null}

      {flash ? <p className="banner banner--ok" role="status"><Icon name="check" size={17} /> {flash}</p> : null}

      {dashboards.isPending ? <LoadingState label="Loading dashboards" /> : null}
      {dashboards.error ? <ErrorState error={dashboards.error} onRetry={() => void dashboards.refetch()} /> : null}

      {dashboards.data?.length ? (
        <div className="composer">
          <nav className="composer__list" aria-label="Dashboards">
            {dashboards.data.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`composer__listitem${d.key === selectedKey ? ' is-active' : ''}`}
                onClick={() => { setSelectedKey(d.key); setTab('layout'); setFlash(null); }}
                aria-current={d.key === selectedKey}
              >
                <span className="composer__listname">{d.name}</span>
                <span className="composer__listmeta">{d.widgetCount} widgets{d.isSystem ? ' · system' : ''}</span>
              </button>
            ))}
          </nav>

          <div className="composer__work">
            <div className="tabs" role="tablist" aria-label="Dashboard settings">
              <button type="button" role="tab" aria-selected={tab === 'layout'}
                      className={`tabs__tab${tab === 'layout' ? ' is-active' : ''}`}
                      onClick={() => setTab('layout')}>Layout</button>
              <button type="button" role="tab" aria-selected={tab === 'access'}
                      className={`tabs__tab${tab === 'access' ? ' is-active' : ''}`}
                      onClick={() => setTab('access')}>Access</button>
              {selected ? (
                <Link className="tabs__aside" to={`/sales/d/${selected.key}`}>
                  Preview <Icon name="right" size={14} />
                </Link>
              ) : null}
            </div>

            {detail.isPending && selectedKey ? <LoadingState label="Loading layout" /> : null}
            {detail.error ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : null}

            {tab === 'layout' && detail.data ? (
              <div className="panes">
                <section className="pane">
                  <header className="pane__head">
                    <h2 className="pane__title">Widget catalogue</h2>
                    <p className="pane__hint">
                      Every widget the module offers, grouped by the data it reads. Adding one from a second
                      group is all a combined dashboard ever is.
                    </p>
                  </header>
                  {catalogue.isPending ? <LoadingState lines={5} /> : null}
                  {catalogue.error ? <ErrorState error={catalogue.error} compact /> : null}
                  <div className="pane__scroll">
                    {grouped.map(([area, widgets]) => (
                      <div key={area} className="catgroup">
                        <p className="catgroup__label">{area}</p>
                        <ul className="catlist">
                          {widgets.map((w) => {
                            const used = layout.filter((p) => p.widgetKey === w.key).length;
                            return (
                              <li key={w.key}>
                                <button type="button" className="catitem" onClick={() => add(w)}>
                                  <span className="catitem__body">
                                    <span className="catitem__name">
                                      {w.name}
                                      <span className={`kindtag kindtag--${w.kind}`}>{w.kind}</span>
                                      {used ? <span className="catitem__used">on this dashboard</span> : null}
                                    </span>
                                    {w.description ? <span className="catitem__desc">{w.description}</span> : null}
                                    {w.requiredPermission ? (
                                      <span className="catitem__perm">
                                        <Icon name="lock" size={12} /> needs {w.requiredPermission}
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="catitem__add"><Icon name="plus" size={16} /></span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="pane">
                  <header className="pane__head">
                    <h2 className="pane__title">{detail.data.name} layout</h2>
                    <p className="pane__hint">
                      {layout.length} widget{layout.length === 1 ? '' : 's'} ·
                      {' '}drawing on {areasInLayout.length || 0} area{areasInLayout.length === 1 ? '' : 's'}
                      {areasInLayout.length ? `: ${areasInLayout.join(', ')}` : ''}
                      {areasInLayout.length > 1 ? ' — this is a combined dashboard, with no special code path behind it.' : ''}
                    </p>
                  </header>

                  <div className="pane__scroll">
                    {!layout.length ? (
                      <p className="notice">This dashboard is empty. Add widgets from the catalogue.</p>
                    ) : (
                      <ol className="layoutlist">
                        {layout.map((p, i) => {
                          const def = byKey.get(p.widgetKey);
                          const min = def?.minWidth ?? 3;
                          const max = def?.maxWidth ?? 12;
                          return (
                            <li key={`${p.widgetKey}-${i}`} className="layoutrow">
                              <span className="layoutrow__pos">{i + 1}</span>
                              <span className="layoutrow__body">
                                <span className="layoutrow__name">
                                  {def?.name ?? p.widgetKey}
                                  {def ? <span className={`kindtag kindtag--${def.kind}`}>{def.kind}</span> : (
                                    <span className="kindtag kindtag--unknown" title="Not in the catalogue this build fetched.">unknown</span>
                                  )}
                                </span>
                                <span className="layoutrow__src">{def ? areaOf(def) : p.widgetKey}</span>
                              </span>
                              <label className="layoutrow__width">
                                <span className="visually-hidden">Width for {def?.name ?? p.widgetKey}</span>
                                <select
                                  className="select select--sm"
                                  value={p.width}
                                  onChange={(e) => setWidth(i, Number(e.target.value))}
                                >
                                  {WIDTHS.filter((w) => w >= min && w <= max).map((w) => (
                                    <option key={w} value={w}>{w}/12</option>
                                  ))}
                                </select>
                              </label>
                              <span className="layoutrow__buttons">
                                <button type="button" className="iconbtn" onClick={() => move(i, -1)} disabled={i === 0}
                                        aria-label={`Move ${def?.name ?? p.widgetKey} up`}>
                                  <Icon name="up" size={15} />
                                </button>
                                <button type="button" className="iconbtn" onClick={() => move(i, 1)} disabled={i === layout.length - 1}
                                        aria-label={`Move ${def?.name ?? p.widgetKey} down`}>
                                  <Icon name="down" size={15} />
                                </button>
                                <button type="button" className="iconbtn iconbtn--danger" onClick={() => removeAt(i)}
                                        aria-label={`Remove ${def?.name ?? p.widgetKey}`}>
                                  <Icon name="minus" size={15} />
                                </button>
                              </span>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>

                  <footer className="pane__foot">
                    {saveLayout.error ? <ErrorState error={saveLayout.error} compact /> : null}
                    <span className="pane__state">{dirty ? 'Unsaved changes' : 'Saved'}</span>
                    <button
                      type="button" className="btn btn--primary"
                      disabled={!dirty || saveLayout.isPending || !dashboardId}
                      onClick={() => saveLayout.mutate()}
                    >
                      {saveLayout.isPending ? 'Saving…' : 'Save layout'}
                    </button>
                  </footer>
                </section>
              </div>
            ) : null}

            {tab === 'access' && dashboardId ? (
              <AccessPane dashboardId={dashboardId} onSaved={() => setFlash('Access updated.')} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- create -- */

function CreateForm({ onSubmit, onCancel, busy, error }: {
  onSubmit: (body: { key: string; name: string; description?: string }) => void;
  onCancel: () => void;
  busy: boolean;
  error: unknown;
}) {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [description, setDescription] = useState('');
  const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  return (
    <form
      className="panel panel--form"
      onSubmit={(e) => { e.preventDefault(); onSubmit({ key: key || slug(name), name, description: description || undefined }); }}
    >
      <div className="formrow">
        <label className="field">
          <span className="field__label">Name</span>
          <input className="input" required value={name}
                 onChange={(e) => { setName(e.target.value); if (!key) setKey(''); }}
                 placeholder="Weekly trading review" />
        </label>
        <label className="field">
          <span className="field__label">Key</span>
          <input className="input mono" value={key || slug(name)} onChange={(e) => setKey(slug(e.target.value))}
                 placeholder="weekly-trading-review" />
        </label>
        <label className="field field--wide">
          <span className="field__label">Description <span className="field__opt">optional</span></span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)}
                 placeholder="What this view is for." />
        </label>
      </div>
      {error ? <ErrorState error={error} compact /> : null}
      <div className="formrow formrow--actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn--primary" disabled={busy || !name}>
          {busy ? 'Creating…' : 'Create dashboard'}
        </button>
      </div>
    </form>
  );
}

/* --------------------------------------------------------------- access -- */

function AccessPane({ dashboardId, onSaved }: { dashboardId: string; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [users, setUsers] = useState<Array<{ userId: string; effect: 'GRANT' | 'REVOKE' }>>([]);
  const [dirty, setDirty] = useState(false);
  const [pick, setPick] = useState('');

  const access = useQuery({
    queryKey: qk.access(dashboardId),
    queryFn: () => api<DashboardAccessResponse>(`/sales/dashboards/${dashboardId}/access`),
  });

  useEffect(() => {
    if (access.data) {
      setRoleIds(access.data.roles.filter((r) => r.granted).map((r) => r.id));
      setUsers(access.data.users.map((u) => ({ userId: u.id, effect: u.effect })));
      setDirty(false);
    }
  }, [access.data]);

  const save = useMutation({
    mutationFn: () => api(`/sales/dashboards/${dashboardId}/access`, {
      method: 'PUT', body: { roleIds, users },
    }),
    onSuccess: async () => {
      setDirty(false);
      onSaved();
      await queryClient.invalidateQueries({ queryKey: ['sales'] });
    },
  });

  if (access.isPending) return <LoadingState label="Loading access" lines={4} />;
  if (access.error) return <ErrorState error={access.error} onRetry={() => void access.refetch()} />;
  if (!access.data) return null;

  const directory = access.data.directory;
  const nameOf = (id: string) => directory.find((d) => d.id === id)?.fullName ?? id;
  const emailOf = (id: string) => directory.find((d) => d.id === id)?.email ?? '';
  const unlisted = directory.filter((d) => !users.some((u) => u.userId === d.id));

  const toggleRole = (id: string) => {
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
    setDirty(true);
  };
  const setEffect = (userId: string, effect: 'GRANT' | 'REVOKE') => {
    setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, effect } : u)));
    setDirty(true);
  };
  const addUser = (userId: string, effect: 'GRANT' | 'REVOKE') => {
    if (!userId) return;
    setUsers((prev) => [...prev.filter((u) => u.userId !== userId), { userId, effect }]);
    setPick('');
    setDirty(true);
  };
  const dropUser = (userId: string) => { setUsers((prev) => prev.filter((u) => u.userId !== userId)); setDirty(true); };

  return (
    <div className="panes">
      <section className="pane">
        <header className="pane__head">
          <h2 className="pane__title">Roles</h2>
          <p className="pane__hint">
            Everyone holding a ticked role sees this dashboard, and it shows on their home screen as
            “via your role”.
          </p>
        </header>
        <div className="pane__scroll">
          <ul className="checklist">
            {access.data.roles.map((role) => (
              <li key={role.id}>
                <label className="check">
                  <input
                    type="checkbox" checked={roleIds.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  <span className="check__box" aria-hidden="true"><Icon name="check" size={13} /></span>
                  <span className="check__text">
                    <strong>{role.name}</strong>
                    <span className="mono">{role.key}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="pane">
        <header className="pane__head">
          <h2 className="pane__title">Individual people</h2>
          <p className="pane__hint">
            A grant adds one person on top of the roles; a revoke takes it away from someone a role would
            otherwise have given it to.
          </p>
        </header>

        <div className="pane__scroll">
          {!users.length ? (
            <p className="notice">No individual overrides. Access is entirely by role.</p>
          ) : (
            <ul className="userlist">
              {users.map((u) => (
                <li key={u.userId} className="userrow">
                  <span className="userrow__who">
                    <strong>{nameOf(u.userId)}</strong>
                    <span>{emailOf(u.userId)}</span>
                  </span>
                  <span className="segmented" role="group" aria-label={`Effect for ${nameOf(u.userId)}`}>
                    <button type="button" className={u.effect === 'GRANT' ? 'is-active' : ''}
                            onClick={() => setEffect(u.userId, 'GRANT')}>Grant</button>
                    <button type="button" className={u.effect === 'REVOKE' ? 'is-active' : ''}
                            onClick={() => setEffect(u.userId, 'REVOKE')}>Revoke</button>
                  </span>
                  <button type="button" className="iconbtn iconbtn--danger" onClick={() => dropUser(u.userId)}
                          aria-label={`Remove override for ${nameOf(u.userId)}`}>
                    <Icon name="minus" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="adduser">
            <label className="field">
              <span className="field__label">Add someone from the directory</span>
              <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Choose a person…</option>
                {unlisted.map((d) => <option key={d.id} value={d.id}>{d.fullName} — {d.email}</option>)}
              </select>
            </label>
            <div className="adduser__buttons">
              <button type="button" className="btn btn--ghost btn--sm" disabled={!pick}
                      onClick={() => addUser(pick, 'GRANT')}>
                <Icon name="plus" size={15} /> Grant
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!pick}
                      onClick={() => addUser(pick, 'REVOKE')}>
                <Icon name="minus" size={15} /> Revoke
              </button>
            </div>
          </div>
        </div>

        <footer className="pane__foot">
          {save.error ? <ErrorState error={save.error} compact /> : null}
          <span className="pane__state">
            {dirty ? 'Unsaved changes' : 'Saved'}
            <Badge tone="neutral">{roleIds.length} roles · {users.length} people</Badge>
          </span>
          <button type="button" className="btn btn--primary" disabled={!dirty || save.isPending}
                  onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save access'}
          </button>
        </footer>
      </section>
    </div>
  );
}
