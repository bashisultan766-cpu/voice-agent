interface FormSectionProps {
  title: string;
  description?: string;
  /** Small label above the title (wizard sections). */
  eyebrow?: string;
  children: React.ReactNode;
}

export function FormSection({ title, description, eyebrow, children }: FormSectionProps) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-7">
      <div className="mb-5 border-b border-border/60 pb-5">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</p>
        )}
        <h2 className={`text-base font-semibold tracking-tight text-foreground ${eyebrow ? 'mt-1' : ''}`}>{title}</h2>
        {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}
