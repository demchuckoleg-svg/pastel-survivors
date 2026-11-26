import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGameServer } from './server';

export * from './coopRoom';
export * from './gameRoom';
export * from './roomManager';
export * from './server';

function isMainEntrypoint(): boolean {
  const argPath = process.argv[1];
  if (!argPath) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argPath);
  } catch {
    return false;
  }
}

if (isMainEntrypoint()) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createGameServer({ port, host });

  server
    .listen(port, host)
    .then((boundPort) => {
      console.log(
        `[pastel-survivors] Authoritative co-op server listening on http://${host}:${boundPort} (ws: /ws, health: /health)`
      );
    })
    .catch((err) => {
      console.error('[pastel-survivors] Failed to start server:', err);
      process.exit(1);
    });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[pastel-survivors] Received ${signal}, shutting down cleanly...`);
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
