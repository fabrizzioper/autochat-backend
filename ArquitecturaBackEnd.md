AutoChat-BackEnd (Code-Oriented)

Backend de AutoChat usando NestJS + TypeORM, con estructura limpia, tipada y escalable.

Objetivo: recibir un código por WhatsApp, buscar datos en BD (cargados desde Excel) y responder automáticamente.

⸻

🧱 Stack
	•	Node.js LTS
	•	NestJS
	•	TypeORM
	•	MySQL / PostgreSQL
	•	TypeScript (strict)

⸻

📁 Estructura (real y mantenible)

src/
├── main.ts
├── app.module.ts
│
├── config/
│   ├── env.schema.ts
│   ├── env.ts
│   └── database.ts
│
├── database/
│   └── typeorm.module.ts
│
├── modules/
│   ├── records/
│   │   ├── record.entity.ts
│   │   ├── records.controller.ts
│   │   ├── records.service.ts
│   │   └── records.module.ts
│   │
│   └── whatsapp/
│       ├── whatsapp.controller.ts
│       ├── whatsapp.service.ts
│       └── whatsapp.module.ts
│
├── migrations/
└── common/
    └── types/


⸻

⚙️ Variables de entorno (tipadas)

.env

PORT=3000

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=autochat
DB_SYNC=false

config/env.schema.ts

import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.string().transform(Number),

  DB_HOST: z.string(),
  DB_PORT: z.string().transform(Number),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string(),
  DB_SYNC: z.string().transform(v => v === 'true'),
});

export type Env = z.infer<typeof envSchema>;

config/env.ts

import { envSchema, Env } from './env.schema';

envSchema.parse(process.env);

export const env: Env = {
  PORT: Number(process.env.PORT),
  DB_HOST: process.env.DB_HOST!,
  DB_PORT: Number(process.env.DB_PORT),
  DB_USER: process.env.DB_USER!,
  DB_PASSWORD: process.env.DB_PASSWORD!,
  DB_NAME: process.env.DB_NAME!,
  DB_SYNC: process.env.DB_SYNC === 'true',
};

❌ Sin any
❌ Sin fallback silencioso

⸻

🗄️ TypeORM Config

config/database.ts

import { DataSourceOptions } from 'typeorm';
import { env } from './env';

export const databaseConfig: DataSourceOptions = {
  type: 'mysql',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/migrations/*.js'],
  synchronize: env.DB_SYNC,
};


⸻

🔌 TypeORM Module

database/typeorm.module.ts

import { TypeOrmModule } from '@nestjs/typeorm';
import { databaseConfig } from '../config/database';

export const DatabaseModule = TypeOrmModule.forRoot(databaseConfig);


⸻

📦 Entidad (100% tipada)

record.entity.ts

import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('records')
export class RecordEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  @Column()
  phone: string;

  @Column()
  message: string;
}


⸻

🧠 Service (sin lógica en controller)

records.service.ts

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RecordEntity } from './record.entity';

@Injectable()
export class RecordsService {
  constructor(
    @InjectRepository(RecordEntity)
    private readonly repo: Repository<RecordEntity>,
  ) {}

  async findByCode(code: string): Promise<RecordEntity | null> {
    return this.repo.findOne({ where: { code } });
  }
}


⸻

🌐 Controller (mínimo)

records.controller.ts

import { Controller, Get, Param } from '@nestjs/common';
import { RecordsService } from './records.service';

@Controller('records')
export class RecordsController {
  constructor(private readonly service: RecordsService) {}

  @Get(':code')
  getByCode(@Param('code') code: string) {
    return this.service.findByCode(code);
  }
}


⸻

🔄 Migraciones

Crear migración

npm run typeorm migration:generate src/migrations/init-records

Ejecutar

npm run typeorm migration:run


⸻

📜 package.json (scripts clave)

{
  "scripts": {
    "start:dev": "nest start --watch",
    "typeorm": "typeorm-ts-node-commonjs"
  }
}


⸻

✅ Principios usados
	•	Tipado estricto
	•	Sin any
	•	Sin fallback oculto
	•	Controllers delgados
	•	Lógica solo en services
	•	Migraciones controladas

⸻

Backend listo para crecer sin reescritura 🚀