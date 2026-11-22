import { Module } from '@nestjs/common';
import { BlobController, MediaController } from './media.controller';
import { MediaService } from './media.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MediaController, BlobController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
