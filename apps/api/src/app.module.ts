import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { KeysModule } from './keys/keys.module';
import { ChatModule } from './chat/chat.module';
import { CallsModule } from './calls/calls.module';
import { GroupsModule } from './groups/groups.module';
import { MediaModule } from './media/media.module';
import { AdminModule } from './admin/admin.module';
import { FriendsModule } from './friends/friends.module';
import { VaultModule } from './vault/vault.module';
import { HealthController } from './common/health.controller';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    AuthModule,
    KeysModule,
    ChatModule,
    CallsModule,
    GroupsModule,
    MediaModule,
    AdminModule,
    FriendsModule,
    VaultModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
