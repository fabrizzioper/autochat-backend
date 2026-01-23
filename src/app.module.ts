import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { ConfigModule } from './modules/config/config.module';
import { ExcelModule } from './modules/excel/excel.module';
import { MessageTemplatesModule } from './modules/message-templates/message-templates.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    WhatsAppModule,
    ConfigModule,
    ExcelModule,
    MessageTemplatesModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
