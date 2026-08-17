import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from './lib/auth';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Home } from './pages/Home';
import { BookRoom } from './pages/BookRoom';
import { MyReservations } from './pages/MyReservations';
import { ManageRooms } from './pages/ManageRooms';
import { SalesIndex } from './pages/SalesIndex';
import { SalesDashboard } from './pages/SalesDashboard';
import { Orders } from './pages/Orders';
import { Composer } from './pages/Composer';
import { Sync } from './pages/Sync';
import { NotFound } from './pages/NotFound';
import { WoroodMark } from './components/Icon';

function Booting() {
  return (
    <div className="booting" role="status">
      <span className="booting__mark"><WoroodMark size={36} /></span>
      <p>Restoring your session…</p>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'restoring') return <Booting />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route path="/" element={<Home />} />

        {/* Module 1. Every path the meeting-rooms descriptor advertises has a
            screen here -- a navigation entry with no route is a link to a dead
            end, which is what these three were before. */}
        <Route path="/meeting-rooms/book" element={<BookRoom />} />
        <Route path="/meeting-rooms/reservations" element={<MyReservations />} />
        <Route path="/meeting-rooms/admin" element={<ManageRooms />} />

        <Route path="/sales" element={<SalesIndex />} />
        <Route path="/sales/d/:key" element={<SalesDashboard />} />
        <Route path="/sales/orders" element={<Orders />} />
        <Route path="/sales/admin" element={<Composer />} />
        <Route path="/sales/admin/sync" element={<Sync />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
