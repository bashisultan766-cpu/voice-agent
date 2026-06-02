/**
 * Custom Next.js server:
 * - Serves the App Router over HTTP
 * - WebSocket endpoint for Twilio ConversationRelay at `/api/twilio/voice/stream`
 *
 * Production: set PORT and HOSTNAME in the process manager (PM2). Defaults are for local dev only.
 * Run via `pnpm start` (tsx + tsconfig-paths) so `@/lib/*` imports resolve outside Next bundler.
 */
import http, { type IncomingMessage, type ServerResponse } from 'http';
import type { Duplex } from 'stream';
import { parse, URL, type UrlWithParsedQuery } from 'node:url';
import next from 'next';
import { WebSocketServer } from 'ws';
import { handleConversationRelayConnection } from './lib/voice/conversation-relay-server';
import { VOICE_WS_PATH } from './lib/voice/constants';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '0.0.0.0';

/** Next.js dev HMR (and other internal upgrades) after `prepare()` — not in public typings. */
type NextAppWithUpgrade = {
  getRequestHandler: () => (
    req: IncomingMessage,
    res: ServerResponse,
    parsedUrl?: UrlWithParsedQuery,
  ) => void | Promise<void>;
  prepare: () => Promise<void>;
  upgradeHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
};

function resolvePort(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}". Use an integer between 1 and 65535.`);
  }
  return port;
}

function resolveHostname(): string {
  const host = process.env.HOSTNAME?.trim() || process.env.HOST?.trim();
  return host || DEFAULT_HOST;
}

async function main() {
  const dev = process.env.NODE_ENV !== 'production';
  const hostname = resolveHostname();
  const port = resolvePort();

  // eslint-disable-next-line no-console
  console.log(
    `[voice] starting (NODE_ENV=${process.env.NODE_ENV ?? 'undefined'}, host=${hostname}, port=${port})`,
  );

  const app = next({ dev }) as unknown as NextAppWithUpgrade;
  const handle = app.getRequestHandler();
  await app.prepare();
  const nextUpgrade = app.upgradeHandler;

  const gated = app as unknown as { setupWebSocketHandler?: () => void };
  gated.setupWebSocketHandler = () => {
    /* no-op: this file owns the only `server.on('upgrade', …)` */
  };

  const server = http.createServer((req, res) => {
    const parsedUrl = parse(req.url || '/', true);
    void handle(req, res, parsedUrl);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${port}`) as string;
      const pathname = new URL(req.url ?? '/', `http://${host}`).pathname;
      if (pathname === VOICE_WS_PATH) {
        wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
          void handleConversationRelayConnection(ws, req);
        });
        return;
      }
      if (typeof nextUpgrade === 'function') {
        void nextUpgrade(req, socket as Duplex, head);
        return;
      }
      socket.destroy();
    } catch {
      socket.destroy();
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(
        `[voice] port ${port} is already in use. Stop the other process or set PORT to a free port.`,
      );
      // eslint-disable-next-line no-console
      console.error('[voice] debug: sudo ss -tlnp | grep :' + String(port));
    } else {
      // eslint-disable-next-line no-console
      console.error('[voice] HTTP server error', err);
    }
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(port, hostname, () => resolve());
    server.once('error', reject);
  });

  // eslint-disable-next-line no-console
  console.log(`[voice] Next.js + ConversationRelay WS ready on http://${hostname}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`[voice] Relay websocket path: ${VOICE_WS_PATH}`);

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[voice] ${signal} received, closing server…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[voice] server failed to start', err);
  process.exit(1);
});
