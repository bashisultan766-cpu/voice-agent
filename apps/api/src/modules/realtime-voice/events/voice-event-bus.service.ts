import { Injectable, Logger } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { VoiceEvent, VoiceEventType } from '../types/events.types';

/**
 * In-process event bus for realtime voice orchestration.
 * WebSocket gateway and analytics agents subscribe here.
 */
@Injectable()
export class VoiceEventBusService {
  private readonly logger = new Logger(VoiceEventBusService.name);
  private readonly bus$ = new Subject<VoiceEvent>();

  emit(type: VoiceEventType, payload: VoiceEvent['payload']): void {
    const event: VoiceEvent = { type, timestamp: Date.now(), payload };
    this.bus$.next(event);
    this.logger.debug(JSON.stringify({ event: `voice.${type}`, callSessionId: payload.callSessionId }));
  }

  stream(callSessionId?: string): Observable<VoiceEvent> {
    return this.bus$.pipe(
      filter((e) => !callSessionId || e.payload.callSessionId === callSessionId),
    );
  }

  on(type: VoiceEventType, handler: (event: VoiceEvent) => void): () => void {
    const sub = this.bus$.pipe(filter((e) => e.type === type)).subscribe(handler);
    return () => sub.unsubscribe();
  }
}
