import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppGateway } from './whatsapp.gateway';

@Module({
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppGateway,
    {
      provide: 'GATEWAY_INIT',
      useFactory: (service: WhatsAppService, gateway: WhatsAppGateway) => {
        service.setGateway(gateway);
        return true;
      },
      inject: [WhatsAppService, WhatsAppGateway],
    },
  ],
  exports: [WhatsAppService, WhatsAppGateway],
})
export class WhatsAppModule {}

