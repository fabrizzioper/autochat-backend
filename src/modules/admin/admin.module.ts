import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { UserEntity } from '../users/user.entity';
import { UserActivityLogEntity } from './user-activity-log.entity';
import { MessageStatsEntity } from './message-stats.entity';
import { AuthorizedNumberEntity } from '../config/authorized-number.entity';
import { AdminGuard } from './guards/admin.guard';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      UserActivityLogEntity,
      MessageStatsEntity,
      AuthorizedNumberEntity,
    ]),
    forwardRef(() => WhatsAppModule),
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminService],
})
export class AdminModule {}
