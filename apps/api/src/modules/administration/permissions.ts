/**
 * Permission keys for the platform itself, in one place so the descriptor, the
 * guards, the rails and the services cannot drift apart on a string literal.
 */
export const CORE_PERMISSIONS = {
  USER_MANAGE: 'core.user.manage',
  ROLE_MANAGE: 'core.role.manage',
  AUDIT_VIEW: 'core.audit.view',
} as const;
