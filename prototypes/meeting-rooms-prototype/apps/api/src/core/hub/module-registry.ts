/**
 * ---------------------------------------------------------------------------
 * HUB MODULE REGISTRY
 * ---------------------------------------------------------------------------
 * This is the contract that makes WOROOD HUB extensible.
 *
 * A feature module (Meeting Rooms today; Leave Requests, Help Desk, Documents,
 * Asset Booking tomorrow) declares one descriptor here. From that single
 * declaration the platform derives:
 *
 *   • the navigation entries in the portal shell
 *   • the dashboard portlets the user sees, and their default grid position
 *   • the permission keys the RBAC seeder registers
 *   • the module list returned by GET /api/v1/hub/modules
 *
 * Adding a module therefore means: create src/modules/<key>/, add its
 * descriptor, add its migration file. No existing module is edited.
 */

export interface HubNavItem {
  label: string;
  labelAr?: string;
  path: string;
  icon: string;
  /** Hidden unless the signed-in user holds one of these permissions. */
  requiresAnyPermission?: string[];
}

export interface HubPortlet {
  /** Unique within the module; the frontend maps this to a React component. */
  key: string;
  title: string;
  titleAr?: string;
  /** Grid width in a 12-column dashboard. */
  width: 3 | 4 | 6 | 8 | 12;
  order: number;
  requiresAnyPermission?: string[];
}

export interface HubModuleDescriptor {
  key: string;
  name: string;
  nameAr?: string;
  description: string;
  version: string;
  icon: string;
  /** Route prefix owned by the module, e.g. /api/v1/meeting-rooms. */
  apiPrefix: string;
  /** Table prefix owned by the module — enforced by convention and review. */
  tablePrefix: string;
  enabled: boolean;
  navigation: HubNavItem[];
  portlets: HubPortlet[];
  permissions: { key: string; description: string }[];
}

const registry = new Map<string, HubModuleDescriptor>();

export function registerHubModule(descriptor: HubModuleDescriptor): HubModuleDescriptor {
  if (registry.has(descriptor.key)) {
    throw new Error(`Hub module "${descriptor.key}" is already registered`);
  }
  registry.set(descriptor.key, descriptor);
  return descriptor;
}

export function getHubModules(): HubModuleDescriptor[] {
  return [...registry.values()].filter((m) => m.enabled);
}

export function getAllPermissionDefinitions(): { key: string; moduleKey: string; description: string }[] {
  return [...registry.values()].flatMap((module) =>
    module.permissions.map((p) => ({ ...p, moduleKey: module.key })),
  );
}
