import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionGuard, AdminGuard } from '../common/guards/session.guard';
import { SessionService } from '../common/session.service';
import { RateLimitService } from '../common/rate-limit.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionService, SessionGuard, AdminGuard, RateLimitService],
  exports: [AuthService, SessionService, SessionGuard, AdminGuard, RateLimitService],
})
export class AuthModule {}
