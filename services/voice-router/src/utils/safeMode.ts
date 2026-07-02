import { getConfig } from "../config.js";

export function isSafeMode(): boolean {
  return getConfig().SAFE_MODE;
}
