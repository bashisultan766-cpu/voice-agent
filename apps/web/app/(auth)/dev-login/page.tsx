import { notFound } from 'next/navigation';

/**
 * Development-only entry point (not linked in the UI). Production returns 404.
 * Normal sign-in remains at /login with workspace slug + email + password.
 */
export default function DevLoginPlaceholderPage() {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm text-sm text-muted-foreground">
      <p className="font-medium text-foreground">Dev login disabled</p>
      <p className="mt-2">
        Use the real sign-in flow at <a href="/login" className="text-foreground underline">/login</a> with your
        workspace slug, email, and password. Header-based tenant bypass is only available when{' '}
        <code className="rounded bg-muted px-1">NODE_ENV !== production</code> and{' '}
        <code className="rounded bg-muted px-1">ALLOW_HEADER_TENANT_FALLBACK=true</code> on the API (never enable in
        production).
      </p>
    </div>
  );
}
