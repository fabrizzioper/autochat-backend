import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigEntity } from './config.entity';
import { AuthorizedNumberEntity } from './authorized-number.entity';
import { UserMessageRoleEntity } from './user-message-role.entity';
import { ConfigService } from './config.service';
import { UserMessageRolesService } from './user-message-roles.service';
import { ConfigController } from './config.controller';
import { UserMessageRolesController } from './user-message-roles.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConfigEntity, AuthorizedNumberEntity, UserMessageRoleEntity]),
    forwardRef(() => AuthModule),
  ],
  providers: [ConfigService, UserMessageRolesService],
  controllers: [ConfigController, UserMessageRolesController],
  exports: [ConfigService, UserMessageRolesService],
})
export class ConfigModule {}

