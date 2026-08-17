import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { CurrentUser, Public, type AuthenticatedUser } from '../../common/auth';

class LoginDto {
  @IsEmail({}, { message: 'A valid work e-mail address is required' })
  email!: string;

  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password!: string;
}

class RefreshDto {
  @IsString()
  refreshToken!: string;
}

class ChangePasswordDto {
  @IsString()
  currentPassword!: string;

  @IsString()
  @MinLength(10, { message: 'New password must be at least 10 characters' })
  newPassword!: string;
}

@ApiTags('Authentication')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private static context(req: Request) {
    return {
      ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip,
      userAgent: req.headers['user-agent'],
    };
  }

  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Sign in with work e-mail and password' })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, AuthController.context(req));
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Exchange a refresh token for a new access token' })
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, AuthController.context(req));
  }

  @Public()
  @Post('logout')
  @ApiOperation({ summary: 'Revoke the presented refresh token' })
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
    return { success: true };
  }

  @Get('me')
  @ApiOperation({ summary: 'Return the signed-in principal' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @Post('change-password')
  @ApiOperation({ summary: 'Change own password and revoke other sessions' })
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    await this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
    return { success: true };
  }
}
