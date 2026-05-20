'use client';

import type { CreateAgentStep } from './form-types';

const STEPS: { step: CreateAgentStep; label: string; short: string }[] = [
  { step: 1, label: 'Basic info', short: 'Basics' },
  { step: 2, label: 'Shopify', short: 'Shopify' },
  { step: 3, label: 'Voice', short: 'Voice' },
  { step: 4, label: 'Sales', short: 'Sales' },
  { step: 5, label: 'Policies', short: 'Policies' },
  { step: 6, label: 'AI', short: 'AI' },
  { step: 7, label: 'Review', short: 'Launch' },
];

interface CreateAgentStepperProps {
  currentStep: CreateAgentStep;
  onStepClick?: (step: CreateAgentStep) => void;
  /** Edit mode shows copy about saving from any step. */
  mode?: 'create' | 'edit';
}

export function CreateAgentStepper({ currentStep, onStepClick, mode = 'create' }: CreateAgentStepperProps) {
  const pct = Math.round(((currentStep - 1) / (STEPS.length - 1)) * 100);

  return (
    <nav
      aria-label="Setup progress"
      className="mb-10 overflow-hidden rounded-2xl border border-border bg-gradient-to-b from-card to-muted/20 shadow-sm"
    >
      <div className="border-b border-border/80 bg-muted/30 px-5 py-4 sm:px-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Create Shopify voice agent
            </p>
            <p className="mt-0.5 text-sm font-medium text-foreground">
              {STEPS.find((s) => s.step === currentStep)?.label ?? 'Setup'}
              <span className="font-normal text-muted-foreground">
                {' '}
                · step {currentStep} of {STEPS.length}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
            <div
              className="h-2 w-28 overflow-hidden rounded-full bg-border sm:w-40"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-600 transition-all duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="px-3 py-5 sm:px-5">
        <div className="flex items-stretch justify-between gap-0.5 sm:gap-1">
          {STEPS.map(({ step, label, short }, index) => {
            const isActive = currentStep === step;
            const isPast = currentStep > step;
            const isClickable = !!onStepClick;
            return (
              <div key={step} className="flex min-w-0 flex-1 items-center">
                <button
                  type="button"
                  onClick={() => isClickable && onStepClick(step)}
                  disabled={!isClickable}
                  className={`group flex w-full min-w-0 flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-center transition-all sm:px-2 sm:py-2.5 ${
                    isClickable ? 'hover:bg-muted/60 cursor-pointer' : 'cursor-default'
                  } ${isActive ? 'ring-2 ring-foreground/20 ring-offset-2 ring-offset-background' : ''}`}
                  title={isClickable ? `Go to: ${label}` : undefined}
                  aria-current={isActive ? 'step' : undefined}
                >
                  <span
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold shadow-sm transition-colors sm:h-9 sm:w-9 sm:text-sm ${
                      isActive
                        ? 'bg-foreground text-background'
                        : isPast
                          ? 'bg-emerald-500 text-white dark:bg-emerald-600'
                          : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {isPast ? '✓' : step}
                  </span>
                  <span
                    className={`hidden max-w-[4.5rem] truncate text-[10px] font-medium leading-tight sm:block sm:max-w-none sm:text-xs ${
                      isActive ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {label}
                  </span>
                  <span
                    className={`max-w-[3.25rem] truncate text-[10px] font-medium leading-tight sm:hidden ${
                      isActive ? 'text-foreground' : 'text-muted-foreground'
                    }`}
                  >
                    {short}
                  </span>
                </button>
                {index < STEPS.length - 1 && (
                  <div
                    className={`mx-0.5 h-0.5 min-w-[6px] flex-1 self-center rounded-full sm:mx-1 ${
                      isPast ? 'bg-emerald-400/80 dark:bg-emerald-700/80' : 'bg-border'
                    }`}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-center text-xs leading-relaxed text-muted-foreground">
          {mode === 'edit' ? (
            <>
              You can jump to any section above. Use <span className="font-medium text-foreground">Update</span> in
              the bar at the bottom when you are ready — your progress is not lost.
            </>
          ) : (
            <>
              One section at a time. Use <span className="font-medium text-foreground">Save as draft</span> anytime if
              you need to pause — we keep a copy on this device too.
            </>
          )}
        </p>
      </div>
    </nav>
  );
}
