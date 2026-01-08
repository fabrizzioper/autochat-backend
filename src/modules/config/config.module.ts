import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigEntity } from './config.entity';
import { AuthorizedNumberEntity } from './authorized-number.entity';
import { ConfigService } from './config.service';
import { ConfigController } from './config.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ConfigEntity, AuthorizedNumberEntity]),
    forwardRef(() => AuthModule),
  ],
  providers: [ConfigService],
  controllers: [ConfigController],
  exports: [ConfigService],
})
export class ConfigModule {}

