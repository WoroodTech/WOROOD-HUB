/**
 * The module contract. A feature module declares one descriptor and the
 * platform derives everything else from it: sidebar navigation filtered per
 * user, the dashboard portlet grid, the permission rows the seeder registers,
 * and the GET /hub/modules response the portal shell reads on boot.
 *
 * The frontend has no hard-coded menu and no hard-coded dashboard.
 */

export interface HubNavEntry {
  label: string; labelAr?: string; path: string; icon: string;
  requiresAnyPermission?: string[];
  /**
   * Show this entry to anyone who manages a department, as well as to anyone
   * with one of the permissions above.
   *
   * Managing a department is authority that does not come from a permission:
   * it is a row in core_department_managers, and a manager who approves his
   * team's spending holds no finance permission at all. An approvals queue
   * gated purely on permissions would therefore be hidden from most of the
   * people who have something in it, and shown to every employee if left
   * ungated -- which is what happened.
   */
  requiresDepartmentManager?: boolean;
}

export interface HubPortletEntry {
  key: string; title: string; titleAr?: string; width: number; order: number;
  /**
   * Module 1 filtered navigation by permission but not portlets, because every
   * employee may see their own next meeting. The sales portlets must be
   * invisible to employees with no sales access, so the registry now filters
   * portlets the same way. This is the one core-platform extension Module 2
   * required, and it is a capability every later module will want.
   */
  requiresAnyPermission?: string[];
}

export interface HubModuleDescriptor {
  key: string; name: string; nameAr?: string; version: string;
  apiPrefix?: string; tablePrefix?: string;
  enabled: boolean; comingSoon?: boolean;
  navigation: HubNavEntry[];
  portlets: HubPortletEntry[];
  permissions: { key: string; description: string }[];
}

const registry: HubModuleDescriptor[] = [];

export function registerHubModule(d: HubModuleDescriptor): HubModuleDescriptor {
  const i = registry.findIndex((m) => m.key === d.key);
  if (i >= 0) registry[i] = d; else registry.push(d);
  return d;
}

export function allModules(): HubModuleDescriptor[] { return registry; }

const visible = (required: string[] | undefined, perms: string[]) =>
  !required || required.length === 0 || required.some((k) => perms.includes(k));

/** An entry is shown when its permissions match, or when it is open to
 *  department managers and this person manages one. Ungated entries are shown
 *  to everybody, as before. */
const navVisible = (
  n: HubNavEntry, perms: string[], managesDepartment: boolean,
): boolean => {
  const gated = (n.requiresAnyPermission?.length ?? 0) > 0 || n.requiresDepartmentManager;
  if (!gated) return true;
  if (visible(n.requiresAnyPermission, perms)
      && (n.requiresAnyPermission?.length ?? 0) > 0) return true;
  return !!n.requiresDepartmentManager && managesDepartment;
};

/** Everything the portal shell needs, already filtered for this employee. */
export function resolveForPrincipal(permissions: string[], managesDepartment = false) {
  const modules = registry.map((m) => ({
    key: m.key, name: m.name, nameAr: m.nameAr, version: m.version,
    enabled: m.enabled, comingSoon: m.comingSoon ?? false,
    navigation: m.enabled
      ? m.navigation.filter((n) => navVisible(n, permissions, managesDepartment))
          .map(({ requiresAnyPermission, ...rest }) => rest)
      : [],
    portlets: m.enabled
      ? m.portlets.filter((p) => visible(p.requiresAnyPermission, permissions))
          .map((p) => ({ key: p.key, moduleKey: m.key, title: p.title,
                         titleAr: p.titleAr, width: p.width, order: p.order }))
      : [],
  }));
  const dashboard = modules.flatMap((m) => m.portlets).sort((a, b) => a.order - b.order);
  return { modules, dashboard };
}