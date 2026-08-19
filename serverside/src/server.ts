import { createApp } from './app';
import { connectDB, disconnectDB } from './config/db';
import { env } from './config/env';
import { OccupancyModel } from './modules/occupancy/occupancy.model';
import { liveHub } from './modules/dashboard/liveHub';

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
    // Before server.close(), not after: close() stops accepting new
    // connections and then waits for the open ones to end. An SSE stream never
    // ends on its own, so a single connected admin console would hold the
    // process until the forced-shutdown timer below fires — turning every
    // deploy into a 10-second hang and a non-zero exit.
    liveHub.closeAll();
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
