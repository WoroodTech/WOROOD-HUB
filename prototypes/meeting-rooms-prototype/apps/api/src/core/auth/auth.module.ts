import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.JWT_ACCESS_SECRET,
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL ?? 900) },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
