/**
 * Detect caller emotional state and adapt tone, pacing, and verbosity.
 */

export type AdaptiveCallerMood = 'neutral' | 'frustrated' | 'confused' | 'impatient' | 'excited';

export type AdaptiveVoiceBehavior = {
  mood: AdaptiveCallerMood;
  toneHint: string;
  maxSentences: number;
  empathyLead: string | null;
  pacing: 'slow' | 'normal' | 'fast';
  verbosity: 'minimal' | 'normal' | 'warm';
};

export function detectAdaptiveCallerMood(text: string, historyLength: number): AdaptiveCallerMood {
  const t = text.toLowerCase().trim();
  if (
    /\b(frustrated|annoyed|angry|upset|ridiculous|terrible|useless|already told|again and again)\b/.test(
      t,
    )
  ) {
    return 'frustrated';
  }
  if (/\b(hurry|quickly|fast|asap|waiting|how long|come on|still there)\b/.test(t)) {
    return 'impatient';
  }
  if (
    /\b(confused|don't understand|not sure what|what do you mean|lost|unclear)\b/.test(t) ||
    (t.includes('?') && historyLength < 2)
  ) {
    return 'confused';
  }
  if (/\b(excited|love it|perfect|great|awesome|can't wait)\b/.test(t)) {
    return 'excited';
  }
  return 'neutral';
}

export function resolveAdaptiveVoiceBehavior(
  text: string,
  historyLength: number,
): AdaptiveVoiceBehavior {
  const mood = detectAdaptiveCallerMood(text, historyLength);
  switch (mood) {
    case 'frustrated':
      return {
        mood,
        toneHint: 'Stay calm, apologize briefly once, be direct and solution-focused.',
        maxSentences: 2,
        empathyLead: 'I understand this is frustrating.',
        pacing: 'normal',
        verbosity: 'minimal',
      };
    case 'impatient':
      return {
        mood,
        toneHint: 'Be very brief; one action per sentence; no filler.',
        maxSentences: 2,
        empathyLead: 'Absolutely — I will be quick.',
        pacing: 'fast',
        verbosity: 'minimal',
      };
    case 'confused':
      return {
        mood,
        toneHint: 'Use simple words; one clarifying question only.',
        maxSentences: 3,
        empathyLead: 'No problem — let me clarify.',
        pacing: 'slow',
        verbosity: 'normal',
      };
    case 'excited':
      return {
        mood,
        toneHint: 'Match positive energy briefly; stay professional.',
        maxSentences: 3,
        empathyLead: 'Great!',
        pacing: 'normal',
        verbosity: 'warm',
      };
    default:
      return {
        mood: 'neutral',
        toneHint: 'Natural, warm, concise bookstore assistant.',
        maxSentences: 3,
        empathyLead: null,
        pacing: 'normal',
        verbosity: 'normal',
      };
  }
}
