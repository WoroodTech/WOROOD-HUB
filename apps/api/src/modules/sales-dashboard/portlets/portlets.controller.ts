/**
 * The personal home-screen portlets.
 *
 * The WOROOD HUB home dashboard is about the signed-in employee, not about the
 * business. my-dashboards and my-alerts are personal by construction -- two
 * employees holding the same permission see different content. store-pulse is
 * the one piece of business content on the personal screen, and it is there
 * deliberately: the people who hold the permission want the number without a
 * click.
 */
import { Controller, Get } from '@nestjs/common';
import { CurrentUser, Permissions, Principal } from '../../../common/auth';
import { query } from '../../../common/db';
import { AccessService } from '../dashboards/access.service';
import { MetricsService } from '../metrics/metrics.service';
import { PERMISSIONS, MyAlertsPortlet, MyDashboardsPortlet } from '../../../contract';

@Controller('sales/portlets')
export class PortletsController {
  constructor(private access: AccessService, private metrics: MetricsService) {}

  @Get('my-dashboards')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  async myDashboards(@CurrentUser() p: Principal): Promise<MyDashboardsPortlet> {
    const dashboards = await this.access.resolve(p);
    // The headline is the dashboard's OWN first KPI, not a fixed metric: a card
    // for Marketing and Traffic that leads with total sales tells the employee
    // nothing about the dashboard they are about to open. It is computed
    // through the same widget code path the dashboard itself uses, so the card
    // and the dashboard cannot disagree.
    const out = await Promise.all(dashboards.slice(0, 6).map(async (d) => {
      const detail = await this.access.detail(p, d.key);
      const firstKpi = detail?.widgets.find((w) => w.kind === 'kpi');
      let headline: { label: string; value: string } | null = null;
      let dataAgeSeconds: number | null = null;

      if (firstKpi) {
        const env = await this.metrics.widget(firstKpi.widgetKey, '30d', p);
        const payload: any = env.payload;
        dataAgeSeconds = env.dataAgeSeconds;
        if (payload) {
          const value = payload.format === 'percent'
            ? `${payload.value.toFixed(2)}%`
            : Math.round(payload.value).toLocaleString('en-EG');
          headline = { label: `${payload.label}, 30 days`, value };
        }
      }
      return { key: d.key, name: d.name, nameAr: d.nameAr, description: d.description,
               headline, dataAgeSeconds };
    }));
    return { dashboards: out };
  }

  @Get('store-pulse')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  pulse(@CurrentUser() p: Principal) { return this.metrics.pulse(p); }

  @Get('my-alerts')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  async myAlerts(@CurrentUser() p: Principal): Promise<MyAlertsPortlet> {
    const rows = await query(
      `SELECT id, severity, title, body, link, read_at, created_at
         FROM core_notifications
        WHERE user_id = $1 AND module_key = 'sales-dashboard'
        ORDER BY created_at DESC LIMIT 8`, [p.id]);
    return {
      alerts: rows.map((r) => ({
        id: r.id, severity: r.severity, title: r.title, body: r.body, link: r.link,
        createdAt: new Date(r.created_at).toISOString(),
        readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
      })),
      unread: rows.filter((r) => !r.read_at).length,
    };
  }
}
