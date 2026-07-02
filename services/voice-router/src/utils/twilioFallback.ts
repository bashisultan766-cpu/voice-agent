import type { Request, Response } from "express";

export const VOICE_ROUTER_ERROR_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, something went wrong. Please try again.</Say></Response>';

export function logTwilioInput(req: Request, route: string): void {
  console.log("INPUT:", req.body);
  console.log("ROUTE:", route);
}

export function logTwilioError(error: unknown): void {
  console.error("VOICE ROUTER CRASH:", error);
  console.log("ERROR:", error instanceof Error ? error.stack : String(error));
}

export function sendTwilioError(res: Response): void {
  if (!res.headersSent) {
    res.type("application/xml").send(VOICE_ROUTER_ERROR_TWIML);
  }
}
