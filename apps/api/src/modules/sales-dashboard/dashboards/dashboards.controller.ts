import {
  Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Req,
} from '@nestjs/common';
import { CurrentUser, Permissions, Principal, can } from '../../../common/auth';
import { query, one, tx } from '../../../common/db';
import { AuditService } from '../../../core/core.module';
import { AccessService } from './access.service';
import { MetricsService, RangeKey, CompareDays } from '../metrics/metrics.service';
import { ShopContext } from '../analytics/snapshot.service';
import { PERMISSIONS, DashboardDataResponse, OrderListResponse } from '../../../contract';

const ipOf = (req: any) =>
  (req?.headers?.['x-forwarded-for']?.split(',')[0] || req?.socket?.remoteAddress || '').trim() || null;

@Controller('sales')
export class DashboardsController {
  constructor(
    private access: AccessService,
    private metrics: MetricsService,
    private shops: ShopContext,
    private audit: AuditService,
  ) {}

  /* ------------------------------------------------------------ viewing -- */

  @Get('dashboards')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  dashboards(@CurrentUser() p: Principal) { return this.access.resolve(p); }

  @Get('dashboards/:key')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  async dashboard(@CurrentUser() p: Principal, @Param('key') key: string) {
    const d = await this.access.detail(p, key);
    if (!d) throw new NotFoundException('Dashboard not found or not assigned to you');
    return d;
  }

  /** All widget payloads in one round trip, computed concurrently. */
  @Get('dashboards/:key/data')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  async dashboardData(@CurrentUser() p: Principal, @Param('key') key: string,
                      @Query('range') range: RangeKey = '30d',
                      /* Two dates, used only when range=compare. Passed through
                         rather than folded into the key so the existing rolling
                         windows are untouched -- this is an extra mode beside
                         them, not a replacement for how they work. */
                      @Query('primary') primary?: string,
                      @Query('against') against?: string): Promise<DashboardDataResponse> {
    const dashboard = await this.access.detail(p, key);
    if (!dashboard) throw new NotFoundException('Dashboard not found or not assigned to you');
    const shop = await this.shops.get();

    const settled = await Promise.allSettled(
      dashboard.widgets.map((w) =>
        this.metrics.widget(w.widgetKey, range, p, { primary, against } as CompareDays)));

    const widgets = settled.map((s, i) => {
      const w = dashboard.widgets[i];
      if (s.status === 'fulfilled') return { ...s.value, title: w.name, titleAr: w.nameAr };
      return { widgetKey: w.widgetKey, title: w.name, titleAr: w.nameAr,
               generatedAt: new Date().toISOString(), dataAgeSeconds: null,
               payload: null, error: String((s as PromiseRejectedResult).reason) };
    });

    return {
      dashboard, widgets, range,
      shop: { name: shop.name, currency: shop.currency_code, timezone: shop.iana_timezone },
      staleAfterMinutes: this.metrics.staleAfterMinutes,
    };
  }

  @Get('widgets/:key/data')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  widgetData(@CurrentUser() p: Principal, @Param('key') key: string,
             @Query('range') range: RangeKey = '30d',
             @Query('primary') primary?: string,
             @Query('against') against?: string) {
    return this.metrics.widget(key, range, p, { primary, against } as CompareDays);
  }

  @Get('widgets')
  @Permissions(PERMISSIONS.DASHBOARD_VIEW, PERMISSIONS.DASHBOARD_MANAGE)
  async widgets(@CurrentUser() p: Principal) {
    const rows = await query(`SELECT * FROM sd_widgets ORDER BY kind, name`);
    return { widgets: rows
      .filter((r) => !r.required_permission || can(p, r.required_permission))
      .map((r) => ({
        key: r.key, name: r.name, nameAr: r.name_ar, description: r.description,
        kind: r.kind, dataSource: r.data_source, requiredPermission: r.required_permission,
        minWidth: r.min_width, maxWidth: r.max_width, defaultWidth: r.default_width,
        defaultConfig: r.default_config,
      })) };
  }

  /* ------------------------------------------------------------- orders -- */

  @Get('orders')
  @Permissions(PERMISSIONS.ORDER_VIEW)
  async orders(@CurrentUser() p: Principal, @Req() req: any,
               @Query('page') pageRaw = '1', @Query('pageSize') sizeRaw = '25',
               @Query('status') status?: string): Promise<OrderListResponse> {
    const shop = await this.shops.get();
    const page = Math.max(parseInt(String(pageRaw), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(sizeRaw), 10) || 25, 1), 100);
    const showCustomer = can(p, PERMISSIONS.CUSTOMER_VIEW);

    /* Deleted orders are excluded here rather than at each call site, so the
       list and the totals below cannot drift apart -- they share this clause.
       An order removed in the Shopify admin is soft-deleted in the mirror; the
       row survives for history, it just stops being counted. */
    const where =
      `o.shop_id = $1 AND o.deleted_at IS NULL ${status ? 'AND o.financial_status = $2' : ''}`;
    const params: any[] = status ? [shop.id, status] : [shop.id];

    const rows = await query(
      `SELECT o.*, c.display_name, c.email AS customer_email,
              (SELECT COUNT(*) FROM sd_order_line_items li WHERE li.order_id = o.id) AS item_count
         FROM sd_orders o LEFT JOIN sd_customers c ON c.id = o.customer_id
        WHERE ${where}
        ORDER BY o.shopify_created_at DESC
        LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);

    const totalsRow = await one(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(o.total_price),0) AS sales,
              COALESCE(SUM(o.net_payment),0) AS collected,
              COALESCE(SUM(o.total_outstanding),0) AS outstanding
         FROM sd_orders o WHERE ${where}`, params);

    // Where identifying fields ARE returned, an audit row is written. This is
    // what discharges Shopify's Level 2 obligation to keep an access log to
    // protected customer data, and it happens in exactly one place.
    if (showCustomer && rows.length) {
      await this.audit.write({
        actorId: p.id, moduleKey: 'sales-dashboard', action: 'sales.customer.read',
        entityType: 'order_list', entityId: `${rows.length} orders`,
        ip: ipOf(req), payload: { page, pageSize },
      });
    }

    return {
      orders: rows.map((r) => ({
        id: r.id, name: r.name,
        createdAt: new Date(r.shopify_created_at).toISOString(),
        financialStatus: r.financial_status, fulfillmentStatus: r.fulfillment_status,
        totalPrice: Number(r.total_price), netPayment: Number(r.net_payment),
        outstanding: Number(r.total_outstanding), currency: r.currency_code,
        test: r.test, cancelledAt: r.cancelled_at ? new Date(r.cancelled_at).toISOString() : null,
        itemCount: Number(r.item_count),
        // Omitted rather than blanked when the permission is absent.
        customer: showCustomer
          ? { displayName: r.display_name, email: r.customer_email, city: r.ship_city }
          : null,
      })),
      total: Number(totalsRow.n), page, pageSize,
      customerDataRedacted: !showCustomer,
      totals: {
        sales: Number(totalsRow.sales), collected: Number(totalsRow.collected),
        outstanding: Number(totalsRow.outstanding), currency: shop.currency_code,
      },
    };
  }

  @Get('orders/:id')
  @Permissions(PERMISSIONS.ORDER_VIEW)
  async order(@CurrentUser() p: Principal, @Req() req: any, @Param('id') id: string) {
    const showCustomer = can(p, PERMISSIONS.CUSTOMER_VIEW);
    const o = await one(
      `SELECT o.*, c.display_name, c.email AS customer_email, c.phone AS customer_phone
         FROM sd_orders o LEFT JOIN sd_customers c ON c.id = o.customer_id
        WHERE o.id = $1`, [id]);
    if (!o) throw new NotFoundException('Order not found');
    const items = await query(
      `SELECT title, variant_title, sku, quantity, current_quantity, discounted_total
         FROM sd_order_line_items WHERE order_id = $1`, [id]);
    const refunds = await query(
      `SELECT total_refunded, shopify_created_at FROM sd_refunds WHERE order_id = $1`, [id]);

    if (showCustomer) {
      await this.audit.write({
        actorId: p.id, moduleKey: 'sales-dashboard', action: 'sales.customer.read',
        entityType: 'order', entityId: o.name, ip: ipOf(req),
      });
    }
    return {
      order: {
        id: o.id, name: o.name, createdAt: o.shopify_created_at,
        financialStatus: o.financial_status, fulfillmentStatus: o.fulfillment_status,
        currency: o.currency_code, presentmentCurrency: o.presentment_currency_code,
        totalPrice: Number(o.total_price), currentTotalPrice: Number(o.current_total_price),
        subtotal: Number(o.subtotal_price), discounts: Number(o.total_discounts),
        tax: Number(o.total_tax), shipping: Number(o.total_shipping),
        refunded: Number(o.total_refunded), netPayment: Number(o.net_payment),
        outstanding: Number(o.total_outstanding),
        cancelledAt: o.cancelled_at, cancelReason: o.cancel_reason, test: o.test,
        customer: showCustomer ? {
          displayName: o.display_name, email: o.customer_email, phone: o.customer_phone,
          city: o.ship_city, province: o.ship_province, country: o.ship_country,
        } : null,
      },
      items, refunds, customerDataRedacted: !showCustomer,
    };
  }

  /* ---------------------------------------------------------- composing -- */

  @Post('dashboards')
  @Permissions(PERMISSIONS.DASHBOARD_MANAGE)
  async create(@CurrentUser() p: Principal,
               @Body() body: { key: string; name: string; nameAr?: string; description?: string }) {
    const row = await one(
      `INSERT INTO sd_dashboards (key, name, name_ar, description, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [body.key, body.name, body.nameAr ?? null, body.description ?? null, p.id]);
    await this.audit.write({ actorId: p.id, moduleKey: 'sales-dashboard',
      action: 'sales.dashboard.created', entityType: 'dashboard', entityId: row.key });
    return row;
  }

  @Patch('dashboards/:id')
  @Permissions(PERMISSIONS.DASHBOARD_MANAGE)
  async update(@CurrentUser() p: Principal, @Param('id') id: string,
               @Body() body: { name?: string; nameAr?: string; description?: string }) {
    const row = await one(
      `UPDATE sd_dashboards SET name = COALESCE($2,name), name_ar = COALESCE($3,name_ar),
              description = COALESCE($4,description)
        WHERE id = $1 RETURNING *`,
      [id, body.name ?? null, body.nameAr ?? null, body.description ?? null]);
    await this.audit.write({ actorId: p.id, moduleKey: 'sales-dashboard',
      action: 'sales.dashboard.updated', entityType: 'dashboard', entityId: id });
    return row;
  }

  /** Replace the layout wholesale -- simpler to reason about than a diff, and
   *  the composer always knows the full intended order. */
  @Put('dashboards/:id/widgets')
  @Permissions(PERMISSIONS.DASHBOARD_MANAGE)
  async setWidgets(@CurrentUser() p: Principal, @Param('id') id: string,
                   @Body() body: { widgets: { widgetKey: string; width: number }[] }) {
    await tx(async (c) => {
      await c.query(`DELETE FROM sd_dashboard_widgets WHERE dashboard_id = $1`, [id]);
      let position = 0;
      for (const w of body.widgets ?? []) {
        const widget = (await c.query(`SELECT id, default_width FROM sd_widgets WHERE key = $1`, [w.widgetKey])).rows[0];
        if (!widget) continue;
        await c.query(
          `INSERT INTO sd_dashboard_widgets (dashboard_id, widget_id, position, width)
           VALUES ($1,$2,$3,$4)`,
          [id, widget.id, position++, w.width || widget.default_width]);
      }
    });
    await this.audit.write({ actorId: p.id, moduleKey: 'sales-dashboard',
      action: 'sales.dashboard.layout_changed', entityType: 'dashboard', entityId: id,
      payload: { widgets: (body.widgets ?? []).map((w) => w.widgetKey) } });
    return { ok: true };
  }

  @Delete('dashboards/:id')
  @Permissions(PERMISSIONS.DASHBOARD_MANAGE)
  async remove(@CurrentUser() p: Principal, @Param('id') id: string) {
    await query(`UPDATE sd_dashboards SET deleted_at = now() WHERE id = $1`, [id]);
    await this.audit.write({ actorId: p.id, moduleKey: 'sales-dashboard',
      action: 'sales.dashboard.retired', entityType: 'dashboard', entityId: id });
    return { ok: true };
  }

  /* ---------------------------------------------------------- assigning -- */

  @Get('dashboards/:id/access')
  @Permissions(PERMISSIONS.DASHBOARD_ASSIGN, PERMISSIONS.DASHBOARD_MANAGE)
  async getAccess(@Param('id') id: string) {
    const roles = await query(
      `SELECT r.id, r.key, r.name,
              EXISTS (SELECT 1 FROM sd_role_dashboard_access a
                       WHERE a.role_id = r.id AND a.dashboard_id = $1) AS granted
         FROM core_roles r ORDER BY r.name`, [id]);
    const users = await query(
      `SELECT u.id, u.full_name, u.email, a.effect
         FROM sd_user_dashboard_access a JOIN core_users u ON u.id = a.user_id
        WHERE a.dashboard_id = $1 ORDER BY u.full_name`, [id]);
    const directory = await query(
      `SELECT id, full_name, email FROM core_users
        WHERE deleted_at IS NULL AND status = 'ACTIVE' ORDER BY full_name`);
    return {
      dashboardId: id,
      roles: roles.map((r) => ({ id: r.id, key: r.key, name: r.name, granted: r.granted })),
      users: users.map((u) => ({ id: u.id, fullName: u.full_name, email: u.email, effect: u.effect })),
      directory: directory.map((u) => ({ id: u.id, fullName: u.full_name, email: u.email })),
    };
  }

  @Put('dashboards/:id/access')
  @Permissions(PERMISSIONS.DASHBOARD_ASSIGN, PERMISSIONS.DASHBOARD_MANAGE)
  async setAccess(@CurrentUser() p: Principal, @Param('id') id: string,
                  @Body() body: { roleIds: string[]; users: { userId: string; effect: 'GRANT' | 'REVOKE' }[] }) {
    await tx(async (c) => {
      await c.query(`DELETE FROM sd_role_dashboard_access WHERE dashboard_id = $1`, [id]);
      for (const roleId of body.roleIds ?? []) {
        await c.query(
          `INSERT INTO sd_role_dashboard_access (role_id, dashboard_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`, [roleId, id]);
      }
      await c.query(`DELETE FROM sd_user_dashboard_access WHERE dashboard_id = $1`, [id]);
      for (const u of body.users ?? []) {
        await c.query(
          `INSERT INTO sd_user_dashboard_access (user_id, dashboard_id, effect, granted_by)
           VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, dashboard_id) DO UPDATE SET effect = EXCLUDED.effect`,
          [u.userId, id, u.effect, p.id]);
      }
    });
    await this.audit.write({ actorId: p.id, moduleKey: 'sales-dashboard',
      action: 'sales.dashboard.access_changed', entityType: 'dashboard', entityId: id,
      payload: body });
    return { ok: true };
  }
}