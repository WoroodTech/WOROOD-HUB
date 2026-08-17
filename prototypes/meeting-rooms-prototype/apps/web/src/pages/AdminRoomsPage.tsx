import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Room } from '../lib/api';
import { Card, Empty, Modal, Spinner, StatusBadge } from '../components/ui';
import { useAuth } from '../lib/auth';

interface Location {
  id: string;
  name: string;
}
interface EquipmentItem {
  id: string;
  key: string;
  name: string;
}

const BLANK = {
  code: '',
  name: '',
  locationId: '',
  floor: '',
  capacity: 8,
  description: '',
  status: 'ACTIVE' as const,
  openingTime: '08:00',
  closingTime: '18:00',
  slotMinutes: 30,
  minDurationMinutes: 30,
  maxDurationMinutes: 240,
  maxAdvanceDays: 90,
  bufferMinutes: 0,
  equipmentKeys: [] as string[],
};

export default function AdminRoomsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<(typeof BLANK & { id?: string }) | null>(null);

  const canManage = can('meeting-rooms.room.manage');

  const { data: rooms, isLoading } = useQuery({
    queryKey: ['rooms', 'all'],
    queryFn: () => api<{ data: Room[] }>('/meeting-rooms/rooms?status=ALL').then((r) => r.data),
    enabled: canManage,
  });

  const { data: locations } = useQuery({
    queryKey: ['locations'],
    queryFn: () => api<{ data: Location[] }>('/meeting-rooms/locations').then((r) => r.data),
    enabled: canManage,
  });

  const { data: equipment } = useQuery({
    queryKey: ['equipment'],
    queryFn: () => api<{ data: EquipmentItem[] }>('/meeting-rooms/equipment').then((r) => r.data),
    enabled: canManage,
  });

  const save = useMutation({
    mutationFn: (room: typeof BLANK & { id?: string }) => {
      const { id, ...body } = room;
      return id
        ? api(`/meeting-rooms/rooms/${id}`, { method: 'PATCH', body })
        : api('/meeting-rooms/rooms', { method: 'POST', body });
    },
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ['rooms'] });
    },
  });

  if (!canManage) {
    return (
      <Card>
        <Empty>You do not have permission to manage rooms.</Empty>
      </Card>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Manage rooms</h1>
          <p className="page-sub">
            Facilities can add rooms and tune booking policy without a code change.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}>
          Add room
        </button>
      </div>

      <Card tight>
        {isLoading ? (
          <Spinner />
        ) : !rooms?.length ? (
          <Empty>No rooms yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Room</th>
                <th>Site</th>
                <th>Seats</th>
                <th>Hours</th>
                <th>Policy</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map((room) => (
                <tr key={room.id}>
                  <td>
                    <div className="strong">{room.name}</div>
                    <div className="muted">{room.code}</div>
                  </td>
                  <td>
                    {room.location.name}
                    {room.floor && <div className="muted">{room.floor}</div>}
                  </td>
                  <td>{room.capacity}</td>
                  <td>
                    {room.openingTime}–{room.closingTime}
                  </td>
                  <td className="muted">
                    {room.minDurationMinutes}–{room.maxDurationMinutes} min
                    {room.bufferMinutes > 0 && <> · {room.bufferMinutes} min buffer</>}
                  </td>
                  <td>
                    <StatusBadge status={room.status} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() =>
                        setEditing({
                          id: room.id,
                          code: room.code,
                          name: room.name,
                          locationId: room.location.id,
                          floor: room.floor ?? '',
                          capacity: room.capacity,
                          description: room.description ?? '',
                          status: room.status as 'ACTIVE',
                          openingTime: room.openingTime,
                          closingTime: room.closingTime,
                          slotMinutes: room.slotMinutes,
                          minDurationMinutes: room.minDurationMinutes,
                          maxDurationMinutes: room.maxDurationMinutes,
                          maxAdvanceDays: room.maxAdvanceDays,
                          bufferMinutes: room.bufferMinutes,
                          equipmentKeys: room.equipment.map((e) => e.key),
                        })
                      }
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.id ? `Edit ${editing.name}` : 'Add a room'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={save.isPending || !editing.name || !editing.code || !editing.locationId}
                onClick={() => save.mutate(editing)}
              >
                {save.isPending ? 'Saving…' : 'Save room'}
              </button>
            </>
          }
        >
          <div className="stack">
            {save.isError && <div className="alert alert-bad">{(save.error as Error).message}</div>}

            <div className="row" style={{ gap: 12 }}>
              <label className="field" style={{ flex: 1 }}>
                Code
                <input
                  value={editing.code}
                  onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                />
              </label>
              <label className="field" style={{ flex: 2 }}>
                Name
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
            </div>

            <div className="row" style={{ gap: 12 }}>
              <label className="field" style={{ flex: 2 }}>
                Site
                <select
                  value={editing.locationId}
                  onChange={(e) => setEditing({ ...editing, locationId: e.target.value })}
                >
                  <option value="">Select a site…</option>
                  {locations?.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ flex: 1 }}>
                Floor
                <input value={editing.floor} onChange={(e) => setEditing({ ...editing, floor: e.target.value })} />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Seats
                <input
                  type="number"
                  min={1}
                  value={editing.capacity}
                  onChange={(e) => setEditing({ ...editing, capacity: Number(e.target.value) })}
                />
              </label>
            </div>

            <label className="field">
              Description
              <textarea
                rows={2}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>

            <div className="row" style={{ gap: 12 }}>
              <label className="field" style={{ flex: 1 }}>
                Opens
                <input
                  type="time"
                  value={editing.openingTime}
                  onChange={(e) => setEditing({ ...editing, openingTime: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Closes
                <input
                  type="time"
                  value={editing.closingTime}
                  onChange={(e) => setEditing({ ...editing, closingTime: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Buffer (min)
                <input
                  type="number"
                  min={0}
                  value={editing.bufferMinutes}
                  onChange={(e) => setEditing({ ...editing, bufferMinutes: Number(e.target.value) })}
                />
              </label>
            </div>

            <div className="row" style={{ gap: 12 }}>
              <label className="field" style={{ flex: 1 }}>
                Min duration
                <input
                  type="number"
                  min={5}
                  value={editing.minDurationMinutes}
                  onChange={(e) => setEditing({ ...editing, minDurationMinutes: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Max duration
                <input
                  type="number"
                  min={15}
                  value={editing.maxDurationMinutes}
                  onChange={(e) => setEditing({ ...editing, maxDurationMinutes: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Book ahead (days)
                <input
                  type="number"
                  min={1}
                  value={editing.maxAdvanceDays}
                  onChange={(e) => setEditing({ ...editing, maxAdvanceDays: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Status
                <select
                  value={editing.status}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as 'ACTIVE' })}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="MAINTENANCE">Maintenance</option>
                  <option value="INACTIVE">Inactive</option>
                </select>
              </label>
            </div>

            <div>
              <div className="muted" style={{ marginBottom: 6 }}>Equipment</div>
              <div className="chip-row">
                {equipment?.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={`slot${editing.equipmentKeys.includes(item.key) ? ' selected' : ''}`}
                    onClick={() =>
                      setEditing({
                        ...editing,
                        equipmentKeys: editing.equipmentKeys.includes(item.key)
                          ? editing.equipmentKeys.filter((k) => k !== item.key)
                          : [...editing.equipmentKeys, item.key],
                      })
                    }
                  >
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
