/**
 * Manage rooms — the Facilities screen.
 *
 * The booking policy is the reason this screen exists. Capacity and a name
 * could live in a spreadsheet; opening hours, the booking horizon, the
 * changeover buffer and the approval flag are what make a room behave
 * correctly without anyone deploying code, so the form treats them as
 * first-class rather than hiding them behind "advanced".
 *
 * The slot grid and the per-room minimum and maximum length used to live here
 * too. They are gone: an employee picks any start time and any length between
 * ten minutes and eight hours, and a room no longer gets an opinion about it.
 * Tying a twenty-minute stand-up to whichever room had been configured
 * generously was the thing people worked around rather than with.
 *
 * Retiring a room is refused by the API while it still has meetings ahead of
 * it. That refusal is shown as-is: the number of affected bookings is the
 * information Facilities need, and inventing a friendlier message would throw
 * it away.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeetingLocation, MeetingRoom, MeetingRoomEquipment } from '../contract';
import { api } from '../lib/api';
import { qk } from '../lib/keys';
import { useToast } from '../lib/toast';
import { Badge, Card } from '../components/Card';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { Icon } from '../components/Icon';

const STATUS_TONE: Record<string, 'good' | 'warning' | 'neutral'> = {
  ACTIVE: 'good', MAINTENANCE: 'warning', INACTIVE: 'neutral',
};

/** Mirrors BOOKING_LIMITS.MIN_MINUTES on the API — the shortest meeting
 *  anyone can book, and therefore the least a room can usefully be open for. */
const MIN_BOOKING_MINUTES = 10;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

type Draft = Partial<MeetingRoom> & { equipmentKeys?: string[] };

export function ManageRooms() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Draft | null>(null);

  const params = 'status=ALL';
  const rooms = useQuery({
    queryKey: qk.rooms(params),
    queryFn: () => api<{ rooms: MeetingRoom[] }>(`/meeting-rooms/rooms?${params}`),
  });
  const locations = useQuery({
    queryKey: qk.roomLocations,
    queryFn: () => api<{ locations: MeetingLocation[] }>('/meeting-rooms/locations'),
    staleTime: 30 * 60 * 1000,
  });
  const catalogue = useQuery({
    queryKey: qk.roomEquipment,
    queryFn: () => api<{ equipment: MeetingRoomEquipment[] }>('/meeting-rooms/equipment'),
    staleTime: 30 * 60 * 1000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['mr'] });
    void queryClient.invalidateQueries({ queryKey: ['portlet'] });
  };

  const save = useMutation({
    mutationFn: (draft: Draft) => draft.id
      ? api<MeetingRoom>(`/meeting-rooms/admin/rooms/${draft.id}`, { method: 'PATCH', body: toBody(draft) })
      : api<MeetingRoom>('/meeting-rooms/admin/rooms', { method: 'POST', body: toBody(draft) }),
    onSuccess: (room) => {
      setEditing(null);
      toast.push(`${room.name} saved.`, 'good');
      refresh();
    },
  });

  const retire = useMutation({
    mutationFn: (id: string) => api(`/meeting-rooms/admin/rooms/${id}`, { method: 'DELETE' }),
    onSuccess: () => { toast.push('Room retired.', 'good'); refresh(); },
    onError: (e) => toast.push(e instanceof Error ? e.message : 'Could not retire that room.', 'warning'),
  });

  return (
    <div className="page">
      <header className="pagehead">
        <div>
          <h1 className="pagehead__title">Manage rooms</h1>
          <p className="pagehead__sub">
            Booking policy lives on the room, so changing it takes effect on the next
            search — no deploy, no restart.
          </p>
        </div>
        <div className="pagehead__tools">
          <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing({})}>
            <Icon name="plus" size={15} /> <span className="btn__label">New room</span>
          </button>
        </div>
      </header>

      {rooms.isPending ? <LoadingState label="Loading rooms" lines={4} /> : null}
      {rooms.error ? <ErrorState error={rooms.error} onRetry={() => void rooms.refetch()} /> : null}

      {rooms.data && !rooms.data.rooms.length ? (
        <Card title="No rooms yet" tone="quiet">
          <EmptyState icon="door" title="Nothing to book" hint="Add the first room to open bookings." />
        </Card>
      ) : null}

      {rooms.data?.rooms.length ? (
        <Card title="Rooms" subtitle={`${rooms.data.rooms.length} in the catalogue`}>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Room</th><th>Where</th><th className="num">Seats</th>
                  <th>Hours</th><th>Policy</th><th>Status</th><th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rooms.data.rooms.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      <span className="cell__sub mono">{r.code}</span>
                    </td>
                    <td>
                      {r.location.name}
                      <span className="cell__sub">{r.floor ? `Floor ${r.floor}` : '—'}</span>
                    </td>
                    <td className="num">{r.capacity}</td>
                    <td className="mono">{r.opensAt}–{r.closesAt}</td>
                    <td>
                      <span className="cell__sub">
                        Bookable {r.maxAdvanceDays} days ahead
                      </span>
                      <span className="cell__sub">
                        {r.bufferMinutes ? `${r.bufferMinutes} min buffer · ` : ''}
                        {r.requiresApproval ? 'approval required' : 'books instantly'}
                      </span>
                    </td>
                    <td><Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Badge></td>
                    <td className="rowactions">
                      <button
                        type="button" className="iconbtn" title={`Edit ${r.name}`}
                        onClick={() => setEditing({ ...r, equipmentKeys: r.equipment.map((e) => e.key) })}
                      >
                        <Icon name="sliders" size={14} />
                      </button>
                      <button
                        type="button" className="iconbtn iconbtn--danger" title={`Retire ${r.name}`}
                        disabled={retire.isPending}
                        onClick={() => retire.mutate(r.id)}
                      >
                        <Icon name="minus" size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {editing ? (
        <RoomForm
          draft={editing}
          locations={locations.data?.locations ?? []}
          catalogue={catalogue.data?.equipment ?? []}
          busy={save.isPending}
          error={save.error}
          onChange={setEditing}
          onClose={() => { save.reset(); setEditing(null); }}
          onSave={() => save.mutate(editing)}
        />
      ) : null}
    </div>
  );
}

/** Only send what the API accepts; the room view carries more than the DTO. */
function toBody(d: Draft): Record<string, unknown> {
  return {
    code: d.code, name: d.name, nameAr: d.nameAr || undefined,
    locationId: d.location?.id, floor: d.floor || undefined,
    capacity: d.capacity, description: d.description || undefined,
    status: d.status, opensAt: d.opensAt, closesAt: d.closesAt,
    maxAdvanceDays: d.maxAdvanceDays,
    bufferMinutes: d.bufferMinutes, requiresApproval: d.requiresApproval,
    equipmentKeys: d.equipmentKeys,
  };
}

function RoomForm({ draft, locations, catalogue, busy, error, onChange, onClose, onSave }: {
  draft: Draft;
  locations: MeetingLocation[];
  catalogue: MeetingRoomEquipment[];
  busy: boolean; error: unknown;
  onChange: (d: Draft) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const set = (patch: Draft) => onChange({ ...draft, ...patch });
  const isNew = !draft.id;

  /* The same rules the API enforces, said before the request rather than after.
     A room that closes before it opens, or is open for less than the shortest
     possible booking, would sit in the catalogue refusing every window. */
  const opens = draft.opensAt ?? '08:00';
  const closes = draft.closesAt ?? '18:00';
  const openMinutes = toMinutes(closes) - toMinutes(opens);
  const badHours = openMinutes < MIN_BOOKING_MINUTES;

  const ready = !!draft.code && !!draft.name && !!draft.location?.id && !!draft.capacity && !badHours;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="room-form-title">
      <button type="button" className="modal__scrim" aria-label="Close" onClick={onClose} />
      <div className="modal__panel modal__panel--wide">
        <header className="modal__head">
          <h2 id="room-form-title" className="modal__title">{isNew ? 'New room' : draft.name}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="minus" size={15} />
          </button>
        </header>

        <div className="modal__body">
          <div className="formrow">
            <label className="field">
              <span className="field__label">Code</span>
              <input className="input mono" value={draft.code ?? ''} maxLength={32}
                     onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              <span className="field__label">Name</span>
              <input className="input" value={draft.name ?? ''} maxLength={160}
                     onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Arabic name <span className="field__opt">optional</span></span>
              <input className="input" dir="rtl" value={draft.nameAr ?? ''} maxLength={160}
                     onChange={(e) => set({ nameAr: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Location</span>
              <select className="select" value={draft.location?.id ?? ''}
                      onChange={(e) => {
                        const l = locations.find((x) => x.id === e.target.value);
                        set({ location: l ? { id: l.id, code: l.code, name: l.name, building: l.building, timezone: l.timezone } : undefined });
                      }}>
                <option value="">Choose…</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Floor</span>
              <input className="input" value={draft.floor ?? ''} maxLength={48}
                     onChange={(e) => set({ floor: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Seats</span>
              <input className="input" type="number" min={1} max={1000} value={draft.capacity ?? ''}
                     onChange={(e) => set({ capacity: Number(e.target.value) || undefined })} />
            </label>
          </div>

          <label className="field field--wide">
            <span className="field__label">Description <span className="field__opt">what someone should know before booking it</span></span>
            <textarea className="input" rows={2} maxLength={1000} value={draft.description ?? ''}
                      onChange={(e) => set({ description: e.target.value })} />
          </label>

          <h3 className="formsection">Booking policy</h3>

          <div className="formrow">
            <label className="field">
              <span className="field__label">Opens</span>
              <input className="input" type="time" value={opens}
                     onChange={(e) => set({ opensAt: e.target.value })} />
            </label>
            <label className="field">
              <span className="field__label">Closes</span>
              <input className="input" type="time" value={closes}
                     onChange={(e) => set({ closesAt: e.target.value })} />
              {badHours ? (
                <span className="field__error">
                  Must be at least {MIN_BOOKING_MINUTES} minutes after opening.
                </span>
              ) : null}
            </label>
            <label className="field">
              <span className="field__label">Bookable ahead</span>
              <input className="input" type="number" min={1} value={draft.maxAdvanceDays ?? 90}
                     onChange={(e) => set({ maxAdvanceDays: Number(e.target.value) || 90 })} />
              <span className="field__opt">days</span>
            </label>
            <label className="field">
              <span className="field__label">Changeover buffer</span>
              <input className="input" type="number" min={0} max={60} step={5}
                     value={draft.bufferMinutes ?? 0}
                     onChange={(e) => set({ bufferMinutes: Number(e.target.value) || 0 })} />
              <span className="field__opt">minutes held either side of every booking</span>
            </label>
            <label className="field">
              <span className="field__label">Status</span>
              <select className="select" value={draft.status ?? 'ACTIVE'}
                      onChange={(e) => set({ status: e.target.value as MeetingRoom['status'] })}>
                <option value="ACTIVE">Active — takes bookings</option>
                <option value="MAINTENANCE">Maintenance — no new bookings</option>
                <option value="INACTIVE">Inactive — hidden</option>
              </select>
            </label>
          </div>

          <label className="checkline">
            <input type="checkbox" checked={draft.requiresApproval ?? false}
                   onChange={(e) => set({ requiresApproval: e.target.checked })} />
            <span>
              <strong>Hold bookings for approval.</strong> The slot is reserved while it waits,
              so nobody else can take it.
            </span>
          </label>

          <h3 className="formsection">Fittings</h3>
          <div className="chiplist">
            {catalogue.map((e) => {
              const on = (draft.equipmentKeys ?? []).includes(e.key);
              return (
                <button
                  key={e.key} type="button" aria-pressed={on}
                  className={`chipbtn${on ? ' chipbtn--on' : ''}`}
                  onClick={() => {
                    const keys = draft.equipmentKeys ?? [];
                    set({ equipmentKeys: on ? keys.filter((k) => k !== e.key) : [...keys, e.key] });
                  }}
                >
                  {on ? <Icon name="check" size={13} /> : null}
                  {e.name}
                </button>
              );
            })}
          </div>

          {error ? (
            <p className="notice notice--error">
              <Icon name="warning" size={15} />
              <span>{error instanceof Error ? error.message : 'Could not save this room.'}</span>
            </p>
          ) : null}
        </div>

        <footer className="modal__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={busy || !ready} onClick={onSave}>
            {busy ? 'Saving…' : isNew ? 'Create room' : 'Save changes'}
          </button>
        </footer>
      </div>
    </div>
  );
}