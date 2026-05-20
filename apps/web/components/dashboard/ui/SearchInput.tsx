export function SearchInput({
  value,
  onChange,
  placeholder,
  className = '',
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative min-w-0 flex-1 sm:max-w-md ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </span>
      <input
        type="search"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-3 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus:border-violet-500/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20 disabled:opacity-50"
      />
    </div>
  );
}
