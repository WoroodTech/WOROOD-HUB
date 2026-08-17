/**
 * People — the administration console's main screen.
 *
 * A directory on the left, one person on the right. The person's panel answers
 * three questions that are usually spread across three screens: who they are,
 * what their roles add up to, and which dashboards they can actually open.
 *
 * The third is the one worth designing carefully. Dashboard access comes from
 * two places — the person's roles, and individual overrides on top — so the
 * list shows *every* dashboard with how they reach it, and lets you flip the
 * override. Showing only what they already have would make granting impossible
 * and would hide the more interesting case: the dashboard their role gives them
 * that you want to take away.
 *
 * Nothing here re-derives a permission rule. `isAdministrator`, `effective` and
 * the per-permission `viaRoles` are all computed by the API, because two
 * implementations of one rule is how they drift apart.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminDepartment, AdminRole, AdminUserDetail, AdminUserSummary,
} from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useAuth } from '../lib/auth';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';
import { formatDateTime } from '../lib/format';

const MIN_PASSWORD = 12;

export function People() {
  const { principal } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'ALL'>('ACTIVE');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const filters = new URLSearchParams({ status, ...(q ? { q } : {}) }).toString();

  const users = useQuery({
    queryKey: qk.adminUsers(filters),
    queryFn: () => api<{ users: AdminUserSummary[] }>(`/admin/users?${filters}`),
  });
  const roles = useQuery({
    queryKey: qk.adminRoles,
    queryFn: () => api<{ roles: AdminRole[] }>('/admin/roles'),
    staleTime: 5 * 60 * 1000,
  });
  const departments = useQuery({
    queryKey: qk.adminDepartments,
    queryFn: () => api<{ departments: AdminDepartment[] }>('/admin/departments'),
    staleTime: 30 * 60 * 1000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });

  const list = users.data?.users ?? [];
  const selected = selectedId ?? list[0]?.id ?? null;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">People</h1>
          <p className="pagehead__sub">
            Accounts, the roles they hold, and the dashboards assigned to them.
            Changes bind on the next request — nobody has to sign out.
          </p>
        </div>
        <div className="pagehead__tools">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} /> <span className="btn__label">New person</span>
          </button>
        </div>
      </header>

      <div className="admin">
        <aside className="admin__list">
          <div className="admin__search">
            <label className="field">
              <span className="visually-hidden">Search people</span>
              <input
                className="input" value={q} placeholder="Name, e-mail or job title"
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <div className="switch" role="group" aria-label="Status">
              {(['ACTIVE', 'ALL'] as const).map((s) => (
                <button
                  key={s} type="button" aria-pressed={status === s}
                  className={`switch__btn${status === s ? ' is-on' : ''}`}
                  onClick={() => setStatus(s)}
                >
                  {s === 'ACTIVE' ? 'Active' : 'All'}
                </button>
              ))}
            </div>
          </div>

          {users.isPending ? <LoadingState label="Loading people" lines={6} /> : null}
          {users.error ? <ErrorState error={users.error} onRetry={() => void users.refetch()} /> : null}
          {users.data && !list.length ? (
            <EmptyState icon="users" title="Nobody matches" hint="Try a different search, or show all." />
          ) : null}

          <ul className="peoplelist">
            {list.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className={`person${selected === u.id ? ' is-on' : ''}`}
                  onClick={() => setSelectedId(u.id)}
                >
                  <span className="person__avatar" aria-hidden="true">{initials(u.fullName)}</span>
                  <span className="person__body">
                    <span className="person__name">
                      {u.fullName}
                      {u.id === principal?.id ? <span className="person__you">you</span> : null}
                    </span>
                    {/* The address, not the job title: this is a screen about
                        accounts, and the address is the identity you search by
                        and change. The job title is on the panel. */}
                    <span className="person__meta">{u.email}</span>
                    <span className="person__roles">
                      {u.roles.length
                        ? u.roles.map((r) => r.name).join(' · ')
                        : <em>no role</em>}
                    </span>
                  </span>
                  {u.status !== 'ACTIVE'
                    ? <Badge tone="warning">suspended</Badge>
                    : u.isAdministrator ? <Badge tone="accent" icon="lock">admin</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="admin__detail">
          {selected ? (
            <PersonPanel
              key={selected}
              userId={selected}
              roles={roles.data?.roles ?? []}
              departments={departments.data?.departments ?? []}
              onChanged={refresh}
              onDeleted={() => { setSelectedId(null); refresh(); }}
            />
          ) : (
            <Card title="Nobody selected" tone="quiet">
              <EmptyState icon="users" title="Pick someone from the list" />
            </Card>
          )}
        </section>
      </div>

      {creating ? (
        <NewPersonDialog
          roles={roles.data?.roles ?? []}
          departments={departments.data?.departments ?? []}
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            setSelectedId(u.id);
            toast.push(`${u.fullName} can sign in now.`, 'good');
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';

/* --------------------------------------------------------- one person -- */

function PersonPanel({ userId, roles, departments, onChanged, onDeleted }: {
  userId: string;
  roles: AdminRole[];
  departments: AdminDepartment[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const { principal } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [settingPassword, setSettingPassword] = useState(false);

  const detail = useQuery({
    queryKey: qk.adminUser(userId),
    queryFn: () => api<AdminUserDetail>(`/admin/users/${userId}`),
  });

  const [draft, setDraft] = useState<Partial<AdminUserDetail> | null>(null);
  const user = detail.data;
  const edited = { ...(user ?? {}), ...(draft ?? {}) } as AdminUserDetail;
  const dirty = !!draft && Object.keys(draft).length > 0;
  const isSelf = user?.id === principal?.id;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<AdminUserDetail>(`/admin/users/${userId}`, { method: 'PATCH', body }),
    onSuccess: (u) => {
      setDraft(null);
      queryClient.setQueryData(qk.adminUser(userId), u);
      toast.push('Saved.', 'good');
      onChanged();
    },
  });

  const setDashboards = useMutation({
    mutationFn: (assignments: Array<{ dashboardId: string; effect: 'GRANT' | 'REVOKE' }>) =>
      api<AdminUserDetail>(`/admin/users/${userId}/dashboards`, { method: 'PUT', body: { assignments } }),
    onSuccess: (u) => {
      queryClient.setQueryData(qk.adminUser(userId), u);
      toast.push('Dashboard access updated.', 'good');
      onChanged();
    },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not change access.', 'warning'),
  });

  const remove = useMutation({
    mutationFn: () => api(`/admin/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => { toast.push('Account deleted.', 'good'); onDeleted(); },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not delete.', 'warning'),
  });

  if (detail.isPending) return <LoadingState label="Loading" lines={8} />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  if (!user) return null;

  const set = (patch: Partial<AdminUserDetail>) => setDraft({ ...(draft ?? {}), ...patch });

  /** Toggling an override cycles: role-only → GRANT / REVOKE → back to none. */
  const toggleDashboard = (d: AdminUserDetail['dashboards'][number]) => {
    const next = user.dashboards
      .map((x) => (x.id === d.id
        ? { ...x, override: nextOverride(x) }
        : x))
      .filter((x) => x.override)
      .map((x) => ({ dashboardId: x.id, effect: x.override as 'GRANT' | 'REVOKE' }));
    setDashboards.mutate(next);
  };

  return (
    <>
      <Card
        title={user.fullName}
        subtitle={user.email}
        actions={
          <span className="card__actionrow">
            {user.isAdministrator ? <Badge tone="accent" icon="lock">administrator</Badge> : null}
            <Badge tone={user.status === 'ACTIVE' ? 'good' : 'warning'}>{user.status.toLowerCase()}</Badge>
          </span>
        }
        footer={
          <span className="cardfoot">
            <span className="muted">
              {user.lastLoginAt ? `Last signed in ${formatDateTime(user.lastLoginAt)}` : 'Has never signed in'}
            </span>
            <span className="cardfoot__actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSettingPassword(true)}>
                <Icon name="lock" size={14} /> <span className="btn__label">Set password</span>
              </button>
              <button
                type="button" className="btn btn--ghost btn--sm"
                disabled={isSelf || remove.isPending}
                title={isSelf ? 'You cannot delete your own account' : undefined}
                onClick={() => remove.mutate()}
              >
                <Icon name="minus" size={14} /> <span className="btn__label">Delete</span>
              </button>
            </span>
          </span>
        }
      >
        <div className="formrow">
          <label className="field">
            <span className="field__label">Full name</span>
            <input className="input" value={edited.fullName ?? ''} maxLength={160}
                   onChange={(e) => set({ fullName: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Arabic name</span>
            <input className="input" dir="rtl" value={edited.fullNameAr ?? ''} maxLength={160}
                   onChange={(e) => set({ fullNameAr: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">E-mail</span>
            <input className="input" type="email" value={edited.email ?? ''} maxLength={190}
                   onChange={(e) => set({ email: e.target.value })} />
            {draft?.email && draft.email !== user.email ? (
              <span className="field__opt">Changing this ends their open sessions.</span>
            ) : null}
          </label>
          <label className="field">
            <span className="field__label">Job title</span>
            <input className="input" value={edited.jobTitle ?? ''} maxLength={160}
                   onChange={(e) => set({ jobTitle: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Department</span>
            <select className="select" value={edited.departmentId ?? ''}
                    onChange={(e) => set({ departmentId: e.target.value || null })}>
              <option value="">None</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Status</span>
            <select
              className="select" value={edited.status ?? 'ACTIVE'}
              disabled={isSelf}
              title={isSelf ? 'You cannot suspend your own account' : undefined}
              onChange={(e) => set({ status: e.target.value as AdminUserDetail['status'] })}
            >
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended — cannot sign in</option>
            </select>
          </label>
        </div>

        <h3 className="formsection">Roles</h3>
        <p className="hint">
          Roles decide what they can <em>do</em>. Dashboards are assigned separately, below.
        </p>
        <div className="chiplist">
          {roles.map((r) => {
            const on = (edited.roles ?? []).some((x) => x.id === r.id);
            return (
              <button
                key={r.id} type="button" aria-pressed={on}
                className={`chipbtn${on ? ' chipbtn--on' : ''}`}
                title={r.permissions.map((p) => p.key).join(', ') || 'Carries no permissions'}
                onClick={() => set({
                  roles: on
                    ? (edited.roles ?? []).filter((x) => x.id !== r.id)
                    : [...(edited.roles ?? []), { id: r.id, key: r.key, name: r.name }],
                })}
              >
                {on ? <Icon name="check" size={13} /> : null}
                {r.name}
                {r.grantsConsole ? <Icon name="lock" size={12} /> : null}
              </button>
            );
          })}
        </div>

        {save.error ? (
          <p className="notice notice--error">
            <Icon name="warning" size={15} />
            <span>{save.error instanceof Error ? save.error.message : 'Could not save.'}</span>
          </p>
        ) : null}

        {dirty ? (
          <div className="savebar">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setDraft(null); save.reset(); }}>
              Discard
            </button>
            <button
              type="button" className="btn btn--primary btn--sm" disabled={save.isPending}
              onClick={() => save.mutate({
                fullName: edited.fullName,
                fullNameAr: edited.fullNameAr || null,
                email: edited.email,
                jobTitle: edited.jobTitle || null,
                departmentId: edited.departmentId ?? undefined,
                status: edited.status,
                roleIds: (edited.roles ?? []).map((r) => r.id),
              })}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        ) : null}
      </Card>

      <Card
        title="Dashboards"
        subtitle="What their role gives them, and what you have changed on top"
      >
        {!user.dashboards.length ? (
          <EmptyState icon="layout-grid" title="No dashboards exist yet" />
        ) : (
          <ul className="grantlist">
            {user.dashboards.map((d) => (
              <li key={d.id} className={`grant${d.effective ? ' is-on' : ''}`}>
                <span className="grant__body">
                  <span className="grant__name">{d.name}</span>
                  <span className="grant__why">{whyText(d)}</span>
                </span>
                <button
                  type="button"
                  className={`btn btn--sm${d.effective ? ' btn--ghost' : ' btn--primary'}`}
                  disabled={setDashboards.isPending}
                  onClick={() => toggleDashboard(d)}
                >
                  {actionLabel(d)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="What they can do" subtitle="Everything their roles add up to" tone="quiet">
        {!user.permissions.length ? (
          <EmptyState icon="lock" title="No permissions"
                      hint="Their roles carry none, so they see only the home screen and meeting rooms." />
        ) : (
          <ul className="permlist">
            {user.permissions.map((p) => (
              <li key={p.key} className="perm">
                <span className="perm__key mono">{p.key}</span>
                <span className="perm__desc">{p.description}</span>
                <span className="perm__via">via {p.viaRoles.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {settingPassword ? (
        <PasswordDialog
          user={user}
          onClose={() => setSettingPassword(false)}
          onDone={(ended) => {
            setSettingPassword(false);
            toast.push(ended
              ? `Password set. ${user.fullName}'s other sessions have been ended.`
              : 'Password set.', 'good');
          }}
        />
      ) : null}
    </>
  );
}

/* The three states a dashboard can be in for one person, said in words rather
   than left as two booleans and an enum for the reader to combine. */
function whyText(d: AdminUserDetail['dashboards'][number]): string {
  if (d.override === 'REVOKE') return d.viaRole
    ? 'Blocked for this person, despite their role'
    : 'Blocked for this person';
  if (d.override === 'GRANT') return d.viaRole
    ? 'Granted individually, and by their role'
    : 'Granted to this person individually';
  return d.viaRole ? 'Through their role' : 'Not assigned';
}

function actionLabel(d: AdminUserDetail['dashboards'][number]): string {
  if (d.override) return 'Reset to role';
  return d.viaRole ? 'Block for them' : 'Assign';
}

function nextOverride(d: AdminUserDetail['dashboards'][number]): 'GRANT' | 'REVOKE' | null {
  if (d.override) return null;               // back to whatever the role says
  return d.viaRole ? 'REVOKE' : 'GRANT';     // block it, or hand it over
}

/* --------------------------------------------------------- dialogs -- */

function PasswordDialog({ user, onClose, onDone }: {
  user: AdminUserDetail;
  onClose: () => void;
  onDone: (endedSessions: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [endOtherSessions, setEnd] = useState(true);

  const set = useMutation({
    mutationFn: () => api<{ sessionsEnded: boolean }>(`/admin/users/${user.id}/password`, {
      method: 'POST', body: { password, endOtherSessions },
    }),
    onSuccess: (r) => onDone(r.sessionsEnded),
  });

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel">
        <header className="modal__head">
          <h2 id="pw-title" className="modal__title">Set a password</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <p className="hint">
            For <strong>{user.fullName}</strong> ({user.email}). You are setting it directly —
            they are not sent anything, so tell them yourself.
          </p>

          <label className="field">
            <span className="field__label">New password</span>
            <input
              className="input" type="text" autoFocus value={password} maxLength={200}
              onChange={(e) => setPassword(e.target.value)}
            />
            <span className={tooShort ? 'field__error' : 'field__opt'}>
              At least {MIN_PASSWORD} characters. Length is the only rule — a long
              phrase beats a short one with punctuation in it.
            </span>
          </label>

          <label className="checkline">
            <input type="checkbox" checked={endOtherSessions} onChange={(e) => setEnd(e.target.checked)} />
            <span>
              <strong>End their other sessions.</strong> Leave this on if the account may be
              compromised. Turn it off only when you are resetting a forgotten password for
              someone who is signed in and staying that way.
            </span>
          </label>

          {set.error ? (
            <p className="notice notice--error">
              <Icon name="warning" size={15} />
              <span>{set.error instanceof Error ? set.error.message : 'Could not set the password.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button
            type="button" className="btn btn--primary"
            disabled={set.isPending || password.length < MIN_PASSWORD}
            onClick={() => set.mutate()}
          >
            {set.isPending ? 'Setting…' : 'Set password'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function NewPersonDialog({ roles, departments, onClose, onCreated }: {
  roles: AdminRole[];
  departments: AdminDepartment[];
  onClose: () => void;
  onCreated: (u: AdminUserDetail) => void;
}) {
  const [form, setForm] = useState({
    email: '', fullName: '', fullNameAr: '', jobTitle: '',
    departmentId: '', password: '', roleIds: [] as string[],
  });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const create = useMutation({
    mutationFn: () => api<AdminUserDetail>('/admin/users', {
      method: 'POST',
      body: {
        email: form.email.trim(),
        fullName: form.fullName.trim(),
        fullNameAr: form.fullNameAr.trim() || undefined,
        jobTitle: form.jobTitle.trim() || undefined,
        departmentId: form.departmentId || undefined,
        password: form.password,
        roleIds: form.roleIds,
      },
    }),
    onSuccess: onCreated,
  });

  const ready = form.email.includes('@') && form.fullName.trim().length >= 2
    && form.password.length >= MIN_PASSWORD;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-person-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel modal__panel--wide">
        <header className="modal__head">
          <h2 id="new-person-title" className="modal__title">New person</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <div className="formrow">
            <label className="field">
              <span className="field__label">Full name</span>
              <input className="input" autoFocus value={form.fullName} maxLength={160}
                     onChange={(e) => set({ fullName: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Arabic name <span className="field__opt">optional</span></span>
              <input className="input" dir="rtl" value={form.fullNameAr} maxLength={160}
                     onChange={(e) => set({ fullNameAr: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Work e-mail</span>
              <input className="input" type="email" value={form.email} maxLength={190}
                     placeholder="name@worood.co"
                     onChange={(e) => set({ email: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Job title</span>
              <input className="input" value={form.jobTitle} maxLength={160}
                     onChange={(e) => set({ jobTitle: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Department</span>
              <select className="select" value={form.departmentId}
                      onChange={(e) => set({ departmentId: e.target.value })}>
                <option value="">None</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Password</span>
              <input className="input" type="text" value={form.password} maxLength={200}
                     onChange={(e) => set({ password: e.target.value })} />
              <span className={form.password && form.password.length < MIN_PASSWORD ? 'field__error' : 'field__opt'}>
                At least {MIN_PASSWORD} characters. You will need to tell them what it is.
              </span>
            </label>
          </div>

          <h3 className="formsection">Roles</h3>
          <div className="chiplist">
            {roles.map((r) => {
              const on = form.roleIds.includes(r.id);
              return (
                <button
                  key={r.id} type="button" aria-pressed={on}
                  className={`chipbtn${on ? ' chipbtn--on' : ''}`}
                  onClick={() => set({
                    roleIds: on ? form.roleIds.filter((x) => x !== r.id) : [...form.roleIds, r.id],
                  })}
                >
                  {on ? <Icon name="check" size={13} /> : null}
                  {r.name}
                  {r.grantsConsole ? <Icon name="lock" size={12} /> : null}
                </button>
              );
            })}
          </div>
          <p className="hint">
            With no role at all they can still sign in, see the home screen and book a
            meeting room. Everything else is granted by a role.
          </p>

          {create.error ? (
            <p className="notice notice--error">
              <Icon name="warning" size={15} />
              <span>{create.error instanceof Error ? create.error.message : 'Could not create the account.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={create.isPending || !ready}
                  onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create account'}
          </button>
        </footer>
      </div>
    </div>
  );
}
