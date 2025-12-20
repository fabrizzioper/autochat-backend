import { DataSourceOptions } from 'typeorm';
import { env } from './env';

export const databaseConfig: DataSourceOptions = {
  type: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  synchronize: env.DB_SYNC,
  logging: false,
};

