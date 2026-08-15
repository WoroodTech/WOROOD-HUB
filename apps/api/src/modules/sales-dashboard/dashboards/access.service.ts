/**
 * Which sales dashboards an employee gets.
 *
 * This resolves DASHBOARDS ONLY. It is not the module's whole authorisation
 * story: the other routes carry their own permission keys independently, so an
 * operations engineer holding only sales.sync.manage reaches Data & Sync
 * without holding sales.dashboard.view at all.
 *
 * Resolved from PostgreSQL on every request and never cached in the token or in
 * Redis beyond a single request. That is what makes an unassignment take effect
 * on the next request with no logout -- a JWT-embedded approach would need a
 * token blocklist to get the same result.
 */
import { Injectable } from '@nestjs/common';
import { query } from '../../../common/db';
import { Principal, can } from '../../../common/auth';
import { DashboardSummary, DashboardDetail, DashboardWidgetPlacement, PERMISSIONS } from '../../../contract';

@Injectable()
export class AccessService {
  async resolve(p: Principal): Promise<DashboardSummary[]> {
    // 1. Without the view permission there are no dashboards. Stop here.
    if (!can(p, PERMISSIONS.DASHBOARD_VIEW) && !can(p, PERMISSIONS.DASHBOARD_MANAGE)) return [];

    // 2. Administrators are identified by permission, not by a column.
    if (can(p, PERMISSIONS.DASHBOARD_MANAGE)) {
      const rows = await query(
        `SELECT d.*, (SELECT COUNT(*) FROM sd_dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count
           FROM sd_dashboards d WHERE d.deleted_at IS NULL ORDER BY d.is_system DESC, d.name`);
      return rows.map((r) => this.toSummary(r, 'ADMIN'));
    }

    // 3. Role defaults, plus individual GRANTs, minus individual REVOKEs.
    const rows = await query(
      `WITH by_role AS (
         SELECT rda.dashboard_id FROM sd_role_dashboard_access rda
           JOIN core_user_roles ur ON ur.role_id = rda.role_id
          WHERE ur.user_id = $1
       ), granted AS (
         SELECT dashboard_id FROM sd_user_dashboard_access
          WHERE user_id = $1 AND effect = 'GRANT'
       ), revoked AS (
         SELECT dashboard_id FROM sd_user_dashboard_access
          WHERE user_id = $1 AND effect = 'REVOKE'
       )
       SELECT d.*,
              (SELECT COUNT(*) FROM sd_dashboard_widgets w WHERE w.dashboard_id = d.id) AS widget_count,
              CASE WHEN d.id IN (SELECT dashboard_id FROM granted) THEN 'USER' ELSE 'ROLE' END AS granted_by
         FROM sd_dashboards d
        WHERE d.deleted_at IS NULL
          AND (d.id IN (SELECT dashboard_id FROM by_role)
            OR d.id IN (SELECT dashboard_id FROM granted))
          AND d.id NOT IN (SELECT dashboard_id FROM revoked)
        ORDER BY d.is_system DESC, d.name`,
      [p.id]);
    return rows.map((r) => this.toSummary(r, r.granted_by));
  }

  async detail(p: Principal, key: string): Promise<DashboardDetail | null> {
    const summaries = await this.resolve(p);
    const summary = summaries.find((s) => s.key === key);
    if (!summary) return null;

    // Any widget whose required_permission the caller lacks is dropped from the
    // layout BEFORE it is returned, so the client never receives a widget it
    // may not see and cannot reveal one by manipulating the response.
    const rows = await query(
      `SELECT dw.id, dw.position, dw.width, dw.config_override,
              w.key, w.name, w.name_ar, w.kind, w.default_config, w.required_permission
         FROM sd_dashboard_widgets dw JOIN sd_widgets w ON w.id = dw.widget_id
        WHERE dw.dashboard_id = $1 ORDER BY dw.position`, [summary.id]);

    const widgets: DashboardWidgetPlacement[] = rows
      .filter((r) => !r.required_permission || can(p, r.required_permission))
      .map((r) => ({
        id: r.id, widgetKey: r.key, name: r.name, nameAr: r.name_ar, kind: r.kind,
        position: r.position, width: r.width,
        config: { ...(r.default_config ?? {}), ...(r.config_override ?? {}) },
      }));

    return { ...summary, widgets };
  }

  /** Used by the socket gateway before joining a room: a socket outlives a
   *  request, and a dashboard can be unassigned mid-session. */
  async mayView(p: Principal, dashboardId: string): Promise<boolean> {
    return (await this.resolve(p)).some((d) => d.id === dashboardId);
  }

  private toSummary(r: any, grantedBy: DashboardSummary['grantedBy']): DashboardSummary {
    return {
      id: r.id, key: r.key, name: r.name, nameAr: r.name_ar,
      description: r.description, isSystem: r.is_system,
      widgetCount: Number(r.widget_count ?? 0), grantedBy,
    };
  }
}
