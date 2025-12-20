import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [DatabaseModule, WhatsAppModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
