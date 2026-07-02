/**
 * Stores ElevenLabs-generated MP3 files and serves public URLs for TwiML <Play>.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig, VOICE_PATH_PREFIX } from "../config.js";
import { logger } from "../utils/logger.js";

export interface StoredAudio {
  id: string;
  url: string;
  filePath: string;
  createdAt: number;
}

const memoryIndex = new Map<string, StoredAudio>();

function audioDir(): string {
  return path.resolve(getConfig().AUDIO_CACHE_DIR);
}

function publicAudioUrl(id: string): string {
  const base = getConfig().PUBLIC_BASE_URL.replace(/\/$/, "");
  return `${base}${VOICE_PATH_PREFIX}/audio/${id}.mp3`;
}

async function ensureAudioDir(): Promise<void> {
  await fs.mkdir(audioDir(), { recursive: true });
}

export async function saveAudio(audio: Buffer, callSid?: string): Promise<StoredAudio> {
  await ensureAudioDir();
  const id = randomUUID();
  const filePath = path.join(audioDir(), `${id}.mp3`);
  await fs.writeFile(filePath, audio);

  const stored: StoredAudio = {
    id,
    url: publicAudioUrl(id),
    filePath,
    createdAt: Date.now(),
  };
  memoryIndex.set(id, stored);

  logger.debug("audio_saved", {
    id: id.slice(0, 8),
    bytes: audio.length,
    callSid: callSid?.slice(0, 8),
  });

  return stored;
}

export async function getAudioFile(id: string): Promise<Buffer | null> {
  const indexed = memoryIndex.get(id);
  if (indexed) {
    try {
      return await fs.readFile(indexed.filePath);
    } catch {
      memoryIndex.delete(id);
    }
  }

  const filePath = path.join(audioDir(), `${id}.mp3`);
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export async function purgeExpiredAudio(): Promise<void> {
  const ttl = getConfig().AUDIO_CACHE_TTL_MS;
  const now = Date.now();
  const dir = audioDir();

  for (const [id, meta] of memoryIndex.entries()) {
    if (now - meta.createdAt > ttl) {
      memoryIndex.delete(id);
      await fs.unlink(meta.filePath).catch(() => undefined);
    }
  }

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".mp3")) continue;
      const filePath = path.join(dir, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > ttl) {
        await fs.unlink(filePath).catch(() => undefined);
        memoryIndex.delete(file.replace(/\.mp3$/, ""));
      }
    }
  } catch {
    // directory may not exist yet
  }
}

/** Test helper */
export function clearAudioIndex(): void {
  memoryIndex.clear();
}
