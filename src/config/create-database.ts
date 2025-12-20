import { Client } from 'pg';
import { env } from './env';

export async function createDatabaseIfNotExists(): Promise<void> {
  const client = new Client({
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: 'postgres',
  });

  try {
    await client.connect();
    
    const result = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [env.DB_NAME]
    );

    if (result.rows.length === 0) {
      await client.query(`CREATE DATABASE ${env.DB_NAME}`);
      console.log(`✅ Base de datos "${env.DB_NAME}" creada exitosamente`);
    } else {
      console.log(`✅ Base de datos "${env.DB_NAME}" ya existe`);
    }
  } catch (error) {
    console.error('❌ Error al crear la base de datos:', error);
    throw error;
  } finally {
    await client.end();
  }
}

