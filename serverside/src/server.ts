import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { OccupancyModel } from './modules/occupancy/occupancy.model';

async function bootstrap(): Promise<void> {
  await connectDB();
  // Anti-passback detection IS the unique index on occupancy: a duplicate-key
  // error is how a repeat entry is caught. Mongoose builds indexes in the
  // background, so serving taps before the build finishes would silently admit
  // passbacks — and any duplicates created in that window make the build fail
  // permanently. Refuse to serve until it exists.
  await OccupancyModel.init();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(async () => {
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[server] forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
