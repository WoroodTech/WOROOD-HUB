/**
 * Roles — the highest-leverage screen in the portal.
 *
 * One checkbox here changes what everyone holding the role can reach, so the
 * holder count is on every row and named on the panel. Editing "Sales Manager"
 * without knowing four people hold it is how a change lands wider than anyone
 * intended, and the fix is not a confirmation dialog — it is showing the number
 * before the click.
 *
 * Permissions are grouped by the module that registered them, because that is
 * how they were designed: keys are independent, not hierarchical, so `admin`
 * does not imply anything and each grant has to be made deliberately.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminPermission, AdminRole } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

const MODULE_LABELS: Record<string, string> = {
  core: 'The platform',
  'meeting-rooms': 'Meeting Rooms',
  'sales-dashboard': 'Sales Dashboard',
};

export function Roles() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const roles = useQuery({
    queryKey: qk.adminRoles,
    queryFn: () => api<{ roles: AdminRole[] }>('/admin/roles'),
  });
  const catalogue = useQuery({
    queryKey: qk.adminPermissions,
    queryFn: () => api<{ permissions: AdminPermission[] }>('/admin/permissions'),
    staleTime: 30 * 60 * 1000,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin'] });

  const list = roles.data?.roles ?? [];
  const selected = list.find((r) => r.id === (selectedId ?? list[0]?.id)) ?? null;

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Roles</h1>
          <p className="pagehead__sub">
            A role is the only place a permission is handed out. Changing one changes
            everyone who holds it.
          </p>
        </div>
        <div className="pagehead__tools">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setCreating(true)}>
            <Icon name="plus" size={15} /> <span className="btn__label">New role</span>
          </button>
        </div>
      </header>

      {roles.isPending ? <LoadingState label="Loading roles" lines={5} /> : null}
      {roles.error ? <ErrorState error={roles.error} onRetry={() => void roles.refetch()} /> : null}

      <div className="admin">
        <aside className="admin__list">
          <ul className="rolelist">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`rolerow${selected?.id === r.id ? ' is-on' : ''}`}
                  onClick={() => setSelectedId(r.id)}
                >
                  <span className="rolerow__body">
                    <span className="rolerow__name">
                      {r.name}
                      {r.grantsConsole ? <Icon name="lock" size={12} /> : null}
                    </span>
                    <span className="rolerow__key mono">{r.key}</span>
                  </span>
                  <span className="rolerow__counts">
                    <span title={`${r.holders} hold this role`}>
                      <Icon name="users" size={13} /> {r.holders}
                    </span>
                    <span title={`${r.permissions.length} permissions`}>
                      <Icon name="lock" size={13} /> {r.permissions.length}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="admin__detail">
          {selected ? (
            <RolePanel
              key={selected.id}
              role={selected}
              catalogue={catalogue.data?.permissions ?? []}
              onChanged={refresh}
              onDeleted={() => { setSelectedId(null); refresh(); }}
            />
          ) : (
            <Card title="No role selected" tone="quiet">
              <EmptyState icon="lock" title="Pick a role from the list" />
            </Card>
          )}
        </section>
      </div>

      {creating ? (
        <NewRoleDialog
          catalogue={catalogue.data?.permissions ?? []}
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            setSelectedId(r.id);
            toast.push(`${r.name} created. Nobody holds it yet.`, 'good');
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ one role -- */

function RolePanel({ role, catalogue, onChanged, onDeleted }: {
  role: AdminRole;
  catalogue: AdminPermission[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [keys, setKeys] = useState<string[]>(role.permissions.map((p) => p.key));
  const [meta, setMeta] = useState({ name: role.name, nameAr: role.nameAr ?? '', description: role.description ?? '' });

  const holders = useQuery({
    queryKey: ['admin', 'role-holders', role.id],
    queryFn: () => api<{ holders: Array<{ id: string; full_name: string; email: string; status: string }> }>(
      `/admin/roles/${role.id}/holders`),
    enabled: role.holders > 0,
  });

  const original = useMemo(() => role.permissions.map((p) => p.key).sort().join('|'), [role]);
  const permsDirty = [...keys].sort().join('|') !== original;
  const metaDirty = meta.name !== role.name
    || meta.nameAr !== (role.nameAr ?? '')
    || meta.description !== (role.description ?? '');

  const save = useMutation({
    mutationFn: () => api<AdminRole>(`/admin/roles/${role.id}`, {
      method: 'PATCH',
      body: {
        key: role.key,
        name: meta.name,
        nameAr: meta.nameAr || undefined,
        description: meta.description || undefined,
        permissionKeys: keys,
      },
    }),
    onSuccess: () => { toast.push(`${meta.name} saved.`, 'good'); onChanged(); },
  });

  const remove = useMutation({
    mutationFn: () => api(`/admin/roles/${role.id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.push('Role deleted.', 'good'); onDeleted(); },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not delete.', 'warning'),
  });

  const byModule = useMemo(() => {
    const map = new Map<string, AdminPermission[]>();
    for (const p of catalogue) {
      const list = map.get(p.moduleKey) ?? [];
      list.push(p);
      map.set(p.moduleKey, list);
    }
    return [...map.entries()];
  }, [catalogue]);

  const losingConsole = role.grantsConsole && !keys.includes('core.user.manage');

  return (
    <>
      <Card
        title={role.name}
        subtitle={<span className="mono">{role.key}</span>}
        actions={
          <span className="card__actionrow">
            {role.grantsConsole ? <Badge tone="accent" icon="lock">opens the console</Badge> : null}
            <Badge tone={role.holders ? 'good' : 'neutral'} icon="users">
              {role.holders} {role.holders === 1 ? 'holder' : 'holders'}
            </Badge>
          </span>
        }
      >
        <div className="formrow">
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={meta.name} maxLength={120}
                   onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Arabic name</span>
            <input className="input" dir="rtl" value={meta.nameAr} maxLength={120}
                   onChange={(e) => setMeta({ ...meta, nameAr: e.target.value })} />
          </label>
        </div>
        <label className="field field--wide">
          <span className="field__label">What this role is for</span>
          <textarea className="input" rows={2} maxLength={500} value={meta.description}
                    onChange={(e) => setMeta({ ...meta, description: e.target.value })} />
        </label>

        <h3 className="formsection">Permissions</h3>
        <p className="hint">
          Keys are independent, not hierarchical — granting one never implies another.
          {role.holders > 0 ? (
            <> Changing these changes what <strong>{role.holders} {role.holders === 1 ? 'person' : 'people'}</strong> can reach.</>
          ) : null}
        </p>

        {byModule.map(([moduleKey, perms]) => (
          <div className="permgroup" key={moduleKey}>
            <h4 className="permgroup__title">{MODULE_LABELS[moduleKey] ?? moduleKey}</h4>
            <ul className="permgroup__list">
              {perms.map((p) => {
                const on = keys.includes(p.key);
                return (
                  <li key={p.key}>
                    <label className={`permcheck${on ? ' is-on' : ''}`}>
                      <input
                        type="checkbox" checked={on}
                        onChange={() => setKeys(on ? keys.filter((k) => k !== p.key) : [...keys, p.key])}
                      />
                      <span>
                        <span className="permcheck__desc">{p.description ?? p.key}</span>
                        <span className="permcheck__key mono">{p.key}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {losingConsole ? (
          <p className="notice notice--warn">
            <Icon name="warning" size={15} />
            <span>
              You are removing the permission that opens this console. If nobody else can
              administer WOROOD HUB, the server will refuse the change.
            </span>
          </p>
        ) : null}

        {save.error ? (
          <p className="notice notice--error">
            <Icon name="warning" size={15} />
            <span>{save.error instanceof Error ? save.error.message : 'Could not save.'}</span>
          </p>
        ) : null}

        {permsDirty || metaDirty ? (
          <div className="savebar">
            <button type="button" className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setKeys(role.permissions.map((p) => p.key));
                      setMeta({ name: role.name, nameAr: role.nameAr ?? '', description: role.description ?? '' });
                      save.reset();
                    }}>
              Discard
            </button>
            <button type="button" className="btn btn--primary btn--sm" disabled={save.isPending}
                    onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save role'}
            </button>
          </div>
        ) : null}
      </Card>

      <Card
        title="Who holds it"
        subtitle={role.holders ? `${role.holders} ${role.holders === 1 ? 'person' : 'people'}` : 'Nobody yet'}
        tone="quiet"
        footer={
          <button
            type="button" className="btn btn--ghost btn--sm"
            disabled={role.holders > 0 || remove.isPending}
            title={role.holders > 0 ? 'Move its holders to another role first' : undefined}
            onClick={() => remove.mutate()}
          >
            <Icon name="minus" size={14} /> <span className="btn__label">Delete this role</span>
          </button>
        }
      >
        {!role.holders ? (
          <EmptyState icon="users" title="Nobody holds this role"
                      hint="Assign it from the People screen." />
        ) : holders.isPending ? <LoadingState lines={3} />
          : (
            <ul className="holderlist">
              {(holders.data?.holders ?? []).map((h) => (
                <li key={h.id} className="holder">
                  <span className="holder__name">{h.full_name}</span>
                  <span className="holder__email muted">{h.email}</span>
                  {h.status !== 'ACTIVE' ? <Badge tone="warning">suspended</Badge> : null}
                </li>
              ))}
            </ul>
          )}
      </Card>
    </>
  );
}

function NewRoleDialog({ catalogue, onClose, onCreated }: {
  catalogue: AdminPermission[];
  onClose: () => void;
  onCreated: (r: AdminRole) => void;
}) {
  const [form, setForm] = useState({ key: '', name: '', nameAr: '', description: '', permissionKeys: [] as string[] });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });

  const create = useMutation({
    mutationFn: () => api<AdminRole>('/admin/roles', {
      method: 'POST',
      body: {
        key: form.key, name: form.name,
        nameAr: form.nameAr || undefined,
        description: form.description || undefined,
        permissionKeys: form.permissionKeys,
      },
    }),
    onSuccess: onCreated,
  });

  /* The key is derived from the name rather than asked for twice, but stays
     editable -- it is what appears in permission checks and audit rows, so
     someone may well want to choose it. */
  const onName = (name: string) => set({
    name,
    key: form.key || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
  });

  const badKey = form.key.length > 0 && !/^[a-z][a-z0-9-]*$/.test(form.key);
  const ready = form.name.trim().length >= 2 && form.key.length >= 2 && !badKey;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="new-role-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel modal__panel--wide">
        <header className="modal__head">
          <h2 id="new-role-title" className="modal__title">New role</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <div className="formrow">
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" autoFocus value={form.name} maxLength={120}
                     placeholder="e.g. Facilities Lead"
                     onChange={(e) => onName(e.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Key</span>
              <input className="input mono" value={form.key} maxLength={48}
                     onChange={(e) => set({ key: e.target.value })} />
              <span className={badKey ? 'field__error' : 'field__opt'}>
                Lower-case letters, digits and hyphens. This is what appears in the audit trail.
              </span>
            </label>
            <label className="field">
              <span className="field__label">Arabic name <span className="field__opt">optional</span></span>
              <input className="input" dir="rtl" value={form.nameAr} maxLength={120}
                     onChange={(e) => set({ nameAr: e.target.value })} />
            </label>
          </div>

          <label className="field field--wide">
            <span className="field__label">What this role is for <span className="field__opt">optional</span></span>
            <textarea className="input" rows={2} maxLength={500} value={form.description}
                      onChange={(e) => set({ description: e.target.value })} />
          </label>

          <h3 className="formsection">Permissions</h3>
          <div className="chiplist">
            {catalogue.map((p) => {
              const on = form.permissionKeys.includes(p.key);
              return (
                <button
                  key={p.key} type="button" aria-pressed={on}
                  className={`chipbtn${on ? ' chipbtn--on' : ''}`}
                  title={p.description ?? p.key}
                  onClick={() => set({
                    permissionKeys: on
                      ? form.permissionKeys.filter((k) => k !== p.key)
                      : [...form.permissionKeys, p.key],
                  })}
                >
                  {on ? <Icon name="check" size={13} /> : null}
                  {p.key}
                </button>
              );
            })}
          </div>

          {create.error ? (
            <p className="notice notice--error">
              <Icon name="warning" size={15} />
              <span>{create.error instanceof Error ? create.error.message : 'Could not create the role.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={create.isPending || !ready}
                  onClick={() => create.mutate()}>
            {create.isPending ? 'Creating…' : 'Create role'}
          </button>
        </footer>
      </div>
    </div>
  );
}
