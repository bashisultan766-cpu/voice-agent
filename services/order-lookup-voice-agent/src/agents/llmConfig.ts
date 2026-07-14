import { getConfig } from "../config.js";

/** Transactional LLM temperature — prefers env LLM_TEMPERATURE (production default 0.2). */
export function getLlmOrchestratorTemperature(): number {
  try {
    return getConfig().LLM_TEMPERATURE;
  } catch {
    return 0.2;
  }
}

/** @deprecated Prefer getLlmOrchestratorTemperature() — kept for static imports. */
export const LLM_ORCHESTRATOR_TEMPERATURE = 0.2;

export function isLlmStreamingEnabled(): boolean {
  try {
    return getConfig().STREAMING_ENABLED;
  } catch {
    return true;
  }
}
