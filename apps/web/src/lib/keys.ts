/** Query keys, in one place, so realtime invalidation can match on them. */
export const qk = {
  hub: ['hub', 'modules'] as const,
  portlet: (moduleKey: string, key: string) => ['portlet', moduleKey, key] as const,
  dashboards: ['sales', 'dashboards'] as const,
  dashboard: (key: string) => ['sales', 'dashboard', key] as const,
  dashboardData: (key: string, range: string) => ['sales', 'dashboard-data', key, range] as const,
  widgets: ['sales', 'widgets'] as const,
  orders: (page: number, pageSize: number) => ['sales', 'orders', page, pageSize] as const,
  access: (id: string) => ['sales', 'access', id] as const,
  sync: ['sales', 'sync'] as const,

  rooms: (filters: string) => ['mr', 'rooms', filters] as const,
  roomLocations: ['mr', 'locations'] as const,
  roomEquipment: ['mr', 'equipment'] as const,
  availability: (filters: string) => ['mr', 'availability', filters] as const,
  reservations: (filters: string) => ['mr', 'reservations', filters] as const,

  adminUsers: (filters: string) => ['admin', 'users', filters] as const,
  adminUser: (id: string) => ['admin', 'user', id] as const,
  adminRoles: ['admin', 'roles'] as const,
  adminPermissions: ['admin', 'permissions'] as const,
  adminDepartments: ['admin', 'departments'] as const,
  adminDashboards: ['admin', 'dashboards'] as const,
  roomCalendar: (roomId: string, date: string) => ['mr', 'room-calendar', roomId, date] as const,
};
