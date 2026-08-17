import { Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchHubModules, fetchMe, fetchNotifications } from './lib/api/mockHub';
import { AppShell } from './components/shell/AppShell';
import { Dashboard } from './pages/Dashboard';
import { PlaceholderPage } from './pages/PlaceholderPage';

export default function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe });

  const modules = useQuery({
    queryKey: ['hub-modules', me.data?.id],
    queryFn: () => fetchHubModules(me.data!),
    enabled: !!me.data,
  });

  const notifications = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    enabled: !!me.data,
  });

  if (me.isLoading || modules.isLoading || !me.data || !modules.data) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <div className="wh-skeleton" style={{ width: 240, height: 24 }} />
      </div>
    );
  }

  return (
    <AppShell principal={me.data} modules={modules.data.modules} notifications={notifications.data ?? []}>
      <Routes>
        <Route path="/" element={<Dashboard principal={me.data} modules={modules.data.modules} />} />
        <Route
          path="/meeting-rooms/book"
          element={<PlaceholderPage title="Book a Room" description="Search availability and reserve a room." />}
        />
        <Route
          path="/meeting-rooms/reservations"
          element={<PlaceholderPage title="My Reservations" description="View, modify or cancel your bookings." />}
        />
        <Route
          path="/meeting-rooms/admin"
          element={<PlaceholderPage title="Manage Rooms" description="Facilities: catalogue and booking policy." />}
        />
      </Routes>
    </AppShell>
  );
}
