import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import type { HubModule, HubNotification, Principal } from '../../lib/types';

interface AppShellProps {
  principal: Principal;
  modules: HubModule[];
  notifications: HubNotification[];
  children: ReactNode;
}

export function AppShell({ principal, modules, notifications, children }: AppShellProps) {
  return (
    <div className="wh-shell" dir={principal.locale === 'ar' ? 'rtl' : 'ltr'}>
      <Sidebar modules={modules} />
      <div>
        <Topbar principal={principal} notifications={notifications} />
        <main className="wh-main">{children}</main>
      </div>
    </div>
  );
}
