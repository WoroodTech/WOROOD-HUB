import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

/* ------------------------------------------------------------------------ */
/* Request-scoped principal                                                  */
/* ------------------------------------------------------------------------ */

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

declare module 'express' {
  interface Request {
    user?: AuthenticatedUser;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<Request>();
    if (!request.user) throw new UnauthorizedException('Not authenticated');
    return request.user;
  },
);

/* ------------------------------------------------------------------------ */
/* Decorators                                                                */
/* ------------------------------------------------------------------------ */

export const IS_PUBLIC = 'auth:isPublic';
/** Marks a route as reachable without a token (login, health, refresh). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'auth:permissions';
/**
 * Guards a route with one or more permission keys.
 * Keys are namespaced by module, e.g. 'meeting-rooms.room.manage'.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/* ------------------------------------------------------------------------ */
/* Guards                                                                    */
/* ------------------------------------------------------------------------ */

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  roles: string[];
  perms: string[];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      request.user = {
        id: payload.sub,
        email: payload.email,
        fullName: payload.name,
        roles: payload.roles ?? [],
        permissions: payload.perms ?? [],
      };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user) throw new UnauthorizedException('Not authenticated');

    const granted = required.some((permission) => user.permissions.includes(permission));
    if (!granted) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    return true;
  }
}
