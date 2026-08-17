import { useQuery } from '@tanstack/react-query';
import { fetchFreeRoomsNow, fetchMyReservations, fetchNextMeeting, fetchNotifications } from '../lib/api/mockHub';
import { ProfileCard } from '../components/portlets/ProfileCard';
import { NextMeetingPortlet } from '../components/portlets/NextMeetingPortlet';
import { FreeRoomsPortlet } from '../components/portlets/FreeRoomsPortlet';
import { MyReservationsPortlet } from '../components/portlets/MyReservationsPortlet';
import { QuickActionsPortlet } from '../components/portlets/QuickActionsPortlet';
import { AnnouncementsPortlet } from '../components/portlets/AnnouncementsPortlet';
import { ComingSoonStrip } from '../components/portlets/ComingSoonStrip';
import type { HubModule, Principal } from '../lib/types';

interface DashboardProps {
  principal: Principal;
  modules: HubModule[];
}

// This is the screen every employee lands on immediately after signing in.
// It is deliberately the one place that pulls together: who they are, what
// needs their attention right now (next meeting, notifications), the single
// most common action (booking a room), and a clear signal of what's coming
// next on the platform. Everything below is composed from the module/portlet
// contract in Technical Design §3.3 — new modules add themselves here by
// registering a descriptor, not by editing this file.
export function Dashboard({ principal, modules }: DashboardProps) {
  const nextMeeting = useQuery({ queryKey: ['next-meeting'], queryFn: fetchNextMeeting });
  const freeRooms = useQuery({ queryKey: ['free-rooms'], queryFn: fetchFreeRoomsNow });
  const reservations = useQuery({ queryKey: ['my-reservations'], queryFn: fetchMyReservations });
  const notifications = useQuery({ queryKey: ['notifications'], queryFn: fetchNotifications });

  return (
    <div className="wh-main" style={{ padding: 0 }}>
      <div>
        <h1 className="wh-page-title">Dashboard</h1>
        <p className="wh-page-subtitle">Everything relevant to you, in one place.</p>
      </div>

      <ProfileCard principal={principal} />

      <div className="wh-grid">
        <div className="wh-col-4">
          {nextMeeting.isLoading ? (
            <Skeleton />
          ) : (
            <NextMeetingPortlet reservation={nextMeeting.data ?? null} timezone={principal.timezone} />
          )}
        </div>
        <div className="wh-col-4">
          {freeRooms.isLoading ? <Skeleton /> : <FreeRoomsPortlet rooms={freeRooms.data ?? []} />}
        </div>
        <div className="wh-col-4">
          <QuickActionsPortlet />
        </div>

        <div className="wh-col-8">
          {reservations.isLoading ? (
            <Skeleton />
          ) : (
            <MyReservationsPortlet reservations={reservations.data ?? []} timezone={principal.timezone} />
          )}
        </div>
        <div className="wh-col-4">
          {notifications.isLoading ? <Skeleton /> : <AnnouncementsPortlet notifications={notifications.data ?? []} />}
        </div>

        <div className="wh-col-12">
          <ComingSoonStrip modules={modules} />
        </div>
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="wh-skeleton" style={{ height: 180, borderRadius: 14 }} />;
}
