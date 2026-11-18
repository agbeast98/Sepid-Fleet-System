import 'reflect-metadata';
import {
  Controller,
  Get,
  Injectable,
  Module,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';

@Injectable()
class Database implements OnApplicationShutdown {
  private readonly pool: Pool;

  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString, connectionTimeoutMillis: 2500 });
    this.pool.on('error', () => console.error('Idle PostgreSQL connection failed'));
  }

  async checkReady(): Promise<void> {
    await this.pool.query('SELECT id FROM machines LIMIT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Controller('health')
class HealthController {
  constructor(private readonly database: Database) {}

  @Get()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.database.checkReady();
      return { status: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Service unavailable');
    }
  }
}

@Module({ controllers: [HealthController], providers: [Database] })
class AppModule {}

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? '3000'), process.env.HOST ?? '127.0.0.1');
}

void main();
