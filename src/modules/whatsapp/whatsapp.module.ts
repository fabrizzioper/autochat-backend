import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppGateway } from './whatsapp.gateway';
import { WhatsAppCredentialsEntity } from './whatsapp-credentials.entity';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';
import { ConfigModule } from '../config/config.module';
import { ExcelModule } from '../excel/excel.module';
import { AuthModule } from '../auth/auth.module';
import { MessageTemplatesModule } from '../message-templates/message-templates.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WhatsAppCredentialsEntity]),
    forwardRef(() => ConfigModule),
    forwardRef(() => ExcelModule),
    forwardRef(() => AuthModule),
    forwardRef(() => MessageTemplatesModule),
    forwardRef(() => AdminModule),
  ],
  controllers: [WhatsAppController],
  providers: [WhatsAppService, WhatsAppGateway, WhatsAppCredentialsService],
  exports: [WhatsAppService, WhatsAppGateway, WhatsAppCredentialsService],
})
export class WhatsAppModule {}
