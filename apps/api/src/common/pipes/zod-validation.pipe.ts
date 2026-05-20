import { PipeTransform, BadRequestException } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/** Validates body/query with Zod; returns parsed output type. */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      const msg = r.error.issues[0]?.message ?? 'Invalid input';
      throw new BadRequestException({
        message: msg,
        code: 'VALIDATION_ERROR',
        issues: r.error.flatten(),
      });
    }
    return r.data;
  }
}
