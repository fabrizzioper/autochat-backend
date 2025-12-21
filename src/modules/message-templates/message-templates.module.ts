import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageTemplateEntity } from './message-template.entity';
import { MessageTemplatesService } from './message-templates.service';
import { MessageTemplatesController } from './message-templates.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([MessageTemplateEntity]),
    forwardRef(() => AuthModule),
  ],
  providers: [MessageTemplatesService],
  controllers: [MessageTemplatesController],
  exports: [MessageTemplatesService],
})
export class MessageTemplatesModule {}

