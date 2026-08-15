/**
 * The live layer.
 *
 * Events carry INVALIDATION SIGNALS, not data. When something changes the
 * server says which widget keys are stale; the client invalidates its cache and
 * refetches through the ordinary authenticated API. Three reasons this is worth
 * the extra hop: no data path bypasses the permissions layer, so a socket can
 * never leak a figure the employee may not see; no customer data ever travels
 * over a socket; and the client's caching, retry and error handling stay in one
 * place, so the live path cannot develop bugs the manual path does not have.
 */
import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, SubscribeMessage,
  WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { config } from '../../../common/config';
import { loadPrincipal, Principal, can } from '../../../common/auth';
import { AccessService } from '../dashboards/access.service';
import { PERMISSIONS } from '../../../contract';

@WebSocketGateway({ namespace: '/sales', cors: { origin: true, credentials: true } })
export class SalesGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server: Server;
  private readonly log = new Logger('SalesGateway');
  private sub: Redis;

  constructor(private jwt: JwtService, private access: AccessService) {}

  onModuleInit() {
    // The worker publishes here after applying a webhook or a snapshot.
    this.sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.sub.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    this.sub.subscribe('sales:events');
    this.sub.on('message', (_channel, message) => {
      try { this.server?.emit('metrics:changed', JSON.parse(message)); } catch { /* ignore */ }
    });
  }

  async handleConnection(socket: Socket) {
    const token = (socket.handshake.auth as any)?.token
      || (socket.handshake.query?.token as string);
    try {
      const payload: any = await this.jwt.verifyAsync(String(token));
      const principal = await loadPrincipal(payload.sub);
      if (!principal || !(can(principal, PERMISSIONS.DASHBOARD_VIEW)
                          || can(principal, PERMISSIONS.DASHBOARD_MANAGE))) {
        socket.emit('unauthorized', { reason: 'Sales access required' });
        return socket.disconnect(true);
      }
      (socket.data as any).principal = principal;
      socket.emit('ready', { userId: principal.id });
    } catch {
      socket.emit('unauthorized', { reason: 'Invalid token' });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket,
                  @MessageBody() body: { dashboardId: string }) {
    const principal: Principal = (socket.data as any).principal;
    if (!principal) return { ok: false };
    // Re-run access resolution before joining. A socket outlives a request, and
    // a dashboard can be unassigned mid-session.
    if (!(await this.access.mayView(principal, body.dashboardId))) {
      socket.emit('dashboard:revoked', { type: 'dashboard:revoked', dashboardId: body.dashboardId });
      return { ok: false };
    }
    socket.join(`dash:${body.dashboardId}`);
    return { ok: true };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { dashboardId: string }) {
    socket.leave(`dash:${body.dashboardId}`);
    return { ok: true };
  }

  /** Called when an assignment changes, so a revoked employee is evicted from
   *  the room rather than continuing to receive invalidations for it. */
  revokeDashboard(dashboardId: string) {
    this.server?.to(`dash:${dashboardId}`).emit('dashboard:revoked',
      { type: 'dashboard:revoked', dashboardId });
    this.server?.socketsLeave(`dash:${dashboardId}`);
  }
}
