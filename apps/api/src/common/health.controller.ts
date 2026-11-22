import { Controller, Get } from '@nestjs/common';

/**
 * Liveness probe. Deliberately unauthenticated and information-free: it reports
 * that the process is up, nothing about versions, config or dependencies. A
 * probe endpoint that leaks build details is reconnaissance for free.
 */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}
