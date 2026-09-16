/**
 * Module 3 permission keys, namespaced by module as the platform requires.
 *
 * ASSIGN is the odd one and the important one. It is NOT seeded onto a role in
 * the normal case -- `loadPrincipal` adds it to anyone who appears in
 * core_department_managers, and `Principal.managedDepartmentIds` then decides
 * where it applies. Granting it through a role would make it company-wide,
 * which is precisely the bug the org chart exists to prevent.
 *
 * Holding the key answers "does this person hand work out at all", which is
 * what the registry needs to decide whether the Department Queue appears in
 * the sidebar. It never answers "may they hand out THIS ticket". Every call
 * site checks the target department as well.
 */
/*
 * There is deliberately no "may see tickets" and no "may raise a ticket" key.
 *
 * Both would gate nothing. Visibility is per ticket -- the filter returns
 * exactly the tickets you are on, so somebody on none sees an empty list with
 * or without a permission -- and asking a colleague for something is what the
 * module is for, not a privilege to be granted. Registering keys that no route
 * checks would put two dead rows on the Roles screen and, worse, set a trap: a
 * role created after this module shipped would be missing them, and whoever
 * created it would spend an afternoon wondering which one broke ticketing.
 *
 * Every key below is checked by something.
 */
export const TASK_PERMISSIONS = {
  /** Assign, reassign, transfer, reject, manage contributors -- scoped. */
  ASSIGN: 'tasks.item.assign',
  /** Read every ticket in the company. */
  VIEW_ANY: 'tasks.item.view-any',
  /** Act on any ticket regardless of department. */
  MANAGE_ANY: 'tasks.item.manage-any',
  /** Reporting by department, ageing and resolution time. */
  REPORT_VIEW: 'tasks.report.view',
} as const;
