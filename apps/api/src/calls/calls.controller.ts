import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CallService } from './call.service';
import { CurrentUser, SessionGuard } from '../common/guards/session.guard';
import type { AuthedUser } from '../common/session.service';

@UseGuards(SessionGuard)
@Controller('calls')
export class CallsController {
  constructor(private readonly calls: CallService) {}

  /** ICE servers + room metadata for a participant joining an existing call. */
  @Get(':roomId')
  async credentials(@CurrentUser() user: AuthedUser, @Param('roomId') roomId: string) {
    return this.calls.credentials(user.userId, user.pseudoId, roomId);
  }
}
