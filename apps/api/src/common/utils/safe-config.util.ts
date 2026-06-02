import type { ConfigService } from '@nestjs/config';

/** Safe ConfigService read — avoids crash when DI fails (e.g. tsx without decorator metadata). */
export function configGet<T>(config: ConfigService | null | undefined, key: string): T | undefined {
  return config?.get<T>(key);
}

export function configGetNumber(
  config: ConfigService | null | undefined,
  key: string,
  fallback: number,
): number {
  const parsed = Number(configGet<string | number>(config, key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function configGetString(
  config: ConfigService | null | undefined,
  key: string,
  fallback = '',
): string {
  const value = configGet<string>(config, key);
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || fallback;
}
