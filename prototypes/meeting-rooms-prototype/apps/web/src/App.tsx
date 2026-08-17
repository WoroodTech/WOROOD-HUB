import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { Spinner } from './components/ui';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import BookPage from './pages/BookPage';
import RoomsPage from './pages/RoomsPage';
import ReservationsPage from './pages/ReservationsPage';
import AdminRoomsPage from './pages/AdminRoomsPage';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spinner label="Loading WOROOD HUB…" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/meeting-rooms/book" element={<BookPage />} />
        <Route path="/meeting-rooms/rooms" element={<RoomsPage />} />
        <Route path="/meeting-rooms/reservations" element={<ReservationsPage />} />
        <Route path="/meeting-rooms/admin" element={<AdminRoomsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
