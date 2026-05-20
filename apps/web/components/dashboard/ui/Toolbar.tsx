import type { ReactNode } from 'react';

export function Toolbar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border border-border/80 bg-muted/20 p-4 sm:flex-row sm:flex-wrap sm:items-center ${className}`}
    >
      {children}
    </div>
  );
}
