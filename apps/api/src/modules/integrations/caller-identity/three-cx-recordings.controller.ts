import {
  Controller,
  Get,
  Logger,
  Param,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator';
import { ThreeCxApiClient } from './three-cx-api.client';

/**
 * Proxies 3CX recording downloads for Eric (authenticated URL, no static files).
 * GET /api/integrations/3cx/recordings/:recId/download?token=...
 */
@Controller('integrations/3cx/recordings')
export class ThreeCxRecordingsController {
  private readonly logger = new Logger(ThreeCxRecordingsController.name);

  constructor(
    private readonly threeCx: ThreeCxApiClient,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @SkipThrottle()
  @Get(':recId/download')
  async download(
    @Param('recId') recId: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const expected =
      this.config.get<string>('THREE_CX_RECORDINGS_TOKEN')?.trim() ||
      this.config.get<string>('THREE_CX_CRM_TOKEN')?.trim();

    if (expected && token?.trim() !== expected) {
      throw new UnauthorizedException('Invalid recordings token.');
    }

    if (!this.threeCx.isConfigured()) {
      res.status(503).json({ success: false, message: '3CX API is not configured.' });
      return;
    }

    const cleanRecId = (recId ?? '').trim();
    if (!cleanRecId) {
      res.status(400).json({ success: false, message: 'recId is required.' });
      return;
    }

    try {
      const file = await this.threeCx.downloadRecording(cleanRecId);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(Buffer.from(file.body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        JSON.stringify({
          event: 'three_cx.recording_download_failed',
          recId: cleanRecId,
          message: message.slice(0, 300),
        }),
      );
      res.status(502).json({ success: false, message: message.slice(0, 200) });
    }
  }
}
