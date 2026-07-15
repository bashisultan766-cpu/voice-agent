import type { Buffer } from "node:buffer";

declare global {
  namespace Express {
    interface Request {
      /** Exact inbound body bytes captured before Express body-parser mutates the stream. */
      rawBody?: Buffer;
    }
  }
}

export {};
