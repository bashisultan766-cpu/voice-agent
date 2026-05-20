import { Injectable } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ConnectionTestResult } from './connection-test.types';

export interface OpenAITestConfig {
  openaiApiKey?: string | null;
}

@Injectable()
export class OpenAIConnectionTestService {
  private readonly log = new Logger(OpenAIConnectionTestService.name);

  validateRequired(config: OpenAITestConfig): string | null {
    const key = config.openaiApiKey?.trim();
    if (!key) return 'OpenAI API key is required to test the connection.';
    return null;
  }

  private sanitizeErrorText(raw: string): string {
    if (!raw) return '';
    return raw
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-****')
      .replace(/sk-proj-[A-Za-z0-9_-]{8,}/g, 'sk-proj-****')
      .slice(0, 240);
  }

  private resolveFailureMessage(status: number, text: string): string {
    const lowered = text.toLowerCase();
    if (status === 401) {
      if (lowered.includes('project') || lowered.includes('organization')) {
        return 'OpenAI rejected this API key. Check the key and organization/project settings.';
      }
      return 'OpenAI rejected this API key. Check the key or project permissions.';
    }
    if (status === 403) return 'OpenAI key does not have permission for this operation.';
    if (status === 429) return 'OpenAI quota/rate limit reached.';
    if (lowered.includes('project') || lowered.includes('organization') || lowered.includes('org_')) {
      return 'OpenAI organization/project mismatch. Confirm the key belongs to the correct project.';
    }
    return `OpenAI API returned ${status}.`;
  }

  async testConnection(config: OpenAITestConfig): Promise<ConnectionTestResult> {
    const validationError = this.validateRequired(config);
    if (validationError) return { success: false, message: validationError };

    const apiKey = config.openaiApiKey!.trim();
    this.log.log(
      JSON.stringify({
        provider: 'openai',
        operation: 'test',
        hasApiKey: true,
        keyLength: apiKey.length,
      }),
    );
    // Cheap "auth check": list models (no streaming, minimal payload).
    try {
      const res = await fetch('https://api.openai.com/v1/models?limit=1', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const clean = this.sanitizeErrorText(text);
        this.log.warn(
          JSON.stringify({
            provider: 'openai',
            operation: 'test',
            hasApiKey: true,
            keyLength: apiKey.length,
            responseStatus: res.status,
            error: clean,
          }),
        );
        return { success: false, message: this.resolveFailureMessage(res.status, clean) };
      }

      // We don't rely on the model data; just confirm success.
      this.log.log(
        JSON.stringify({
          provider: 'openai',
          operation: 'test',
          hasApiKey: true,
          keyLength: apiKey.length,
          responseStatus: res.status,
        }),
      );
      return { success: true, message: 'OpenAI connection successful.' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const clean = this.sanitizeErrorText(message);
      this.log.warn(
        JSON.stringify({
          provider: 'openai',
          operation: 'test',
          hasApiKey: true,
          keyLength: apiKey.length,
          error: clean,
        }),
      );
      if (message.includes('fetch') || message.includes('Failed') || message.includes('ENOTFOUND') || message.includes('ECONN')) {
        return { success: false, message: 'Could not reach OpenAI API.' };
      }
      return { success: false, message: `OpenAI connection failed: ${clean}` };
    }
  }
}

