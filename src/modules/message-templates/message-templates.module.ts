import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageTemplateEntity } from './message-template.entity';
import { MessageRoleEntity } from './message-role.entity';
import { ExcelFormatEntity } from '../excel/excel-format.entity';
import { MessageTemplatesService } from './message-templates.service';
import { MessageRolesService } from './message-roles.service';
import { MessageTemplatesController } from './message-templates.controller';
import { MessageRolesController } from './message-roles.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MessageTemplateEntity, MessageRoleEntity, ExcelFormatEntity]),
    forwardRef(() => AuthModule),
  ],
  providers: [MessageTemplatesService, MessageRolesService],
  controllers: [MessageTemplatesController, MessageRolesController],
  exports: [MessageTemplatesService, MessageRolesService],
})
export class MessageTemplatesModule {}

