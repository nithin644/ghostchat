import { Module } from '@nestjs/common';
import { CallsController } from './calls.controller';
import { CallService } from './call.service';
import { CallsGateway } from './calls.gateway';
import { AuthModule } from '../auth/auth.module';
import { ChatModule } from '../chat/chat.module';

@Module({
  imports: [AuthModule, ChatModule],
  controllers: [CallsController],
  providers: [CallService, CallsGateway],
  exports: [CallService],
})
export class CallsModule {}
