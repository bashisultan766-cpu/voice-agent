'use client';

import type { VoicePersonalityTraits } from '@bookstore-voice-agents/types';
import { DEFAULT_VOICE_PERSONALITY } from '@bookstore-voice-agents/types';

const SLIDERS: Array<{ key: keyof VoicePersonalityTraits; label: string }> = [
  { key: 'voiceEnergy', label: 'Voice energy' },
  { key: 'speakingSpeed', label: 'Speaking speed' },
  { key: 'politeness', label: 'Politeness' },
  { key: 'upsellAggressiveness', label: 'Upsell aggressiveness' },
  { key: 'humorLevel', label: 'Humor level' },
];

export interface VoicePersonalitySectionProps {
  value: VoicePersonalityTraits;
  onChange: (next: VoicePersonalityTraits) => void;
  disabled?: boolean;
}

export function VoicePersonalitySection({ value, onChange, disabled }: VoicePersonalitySectionProps) {
  const merged = { ...DEFAULT_VOICE_PERSONALITY, ...value };

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h3 className="text-sm font-semibold">Voice personality</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Traits are injected into the runtime system prompt (0 = low, 100 = high).
        </p>
      </div>
      {SLIDERS.map(({ key, label }) => (
        <div key={key}>
          <div className="mb-1 flex justify-between text-sm">
            <span>{label}</span>
            <span className="tabular-nums text-muted-foreground">{merged[key] ?? 50}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            disabled={disabled}
            value={merged[key] ?? 50}
            onChange={(e) => onChange({ ...merged, [key]: Number(e.target.value) })}
            className="w-full"
          />
        </div>
      ))}
    </div>
  );
}
