export function FilterSelect<T extends string>({
  value,
  onChange,
  options,
  className = '',
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as T)}
      className={`rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground shadow-sm focus:border-violet-500/40 focus:outline-none focus:ring-2 focus:ring-violet-500/20 disabled:opacity-50 ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
