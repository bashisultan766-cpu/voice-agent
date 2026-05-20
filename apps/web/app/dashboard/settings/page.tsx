import Link from 'next/link';
import { getSessionProfile } from '@/lib/api/auth-server';
import { PageHeader } from '@/components/dashboard/ui/PageHeader';
import { LogoutButton } from './LogoutButton';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const { profile, error } = await getSessionProfile();

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Workspace profile, integrations, and session."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/dashboard/stores"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium shadow-sm hover:bg-muted"
            >
              Stores
            </Link>
            <LogoutButton />
          </div>
        }
      />

      {error ? (
        <div className="rounded-xl border border-red-200/80 bg-red-50/50 px-6 py-8 dark:border-red-900/50 dark:bg-red-950/30">
          <p className="text-sm font-medium text-red-800 dark:text-red-300">Could not load your session</p>
          <p className="mt-2 text-sm text-red-700/90 dark:text-red-200/90">{error}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            If you are signed in, check that the API is running and your token is valid. You can try signing out and back in.
          </p>
        </div>
      ) : !profile ? (
        <div className="rounded-xl border border-border bg-card px-6 py-8 text-sm text-muted-foreground">
          You are not signed in, or the session expired.{' '}
          <Link href="/login" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
            Go to login
          </Link>
        </div>
      ) : (
        <div className="space-y-8">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Integrations</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Connect production credentials per workspace. Values are encrypted; secrets are never shown again after save.
            </p>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              <li>
                <Link
                  href="/dashboard/settings/integrations/shopify"
                  className="block rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
                >
                  Shopify
                </Link>
              </li>
              <li>
                <Link
                  href="/dashboard/settings/integrations/twilio"
                  className="block rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
                >
                  Twilio
                </Link>
              </li>
              <li>
                <Link
                  href="/dashboard/settings/integrations/openai"
                  className="block rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
                >
                  OpenAI
                </Link>
              </li>
              <li>
                <Link
                  href="/dashboard/settings/integrations/elevenlabs"
                  className="block rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
                >
                  ElevenLabs
                </Link>
              </li>
              <li>
                <Link
                  href="/dashboard/settings/integrations/email"
                  className="block rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium hover:bg-muted"
                >
                  Email (Resend)
                </Link>
              </li>
            </ul>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium text-foreground text-right">{profile.tenant.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Slug</dt>
                <dd className="font-mono text-xs text-foreground text-right">{profile.tenant.slug}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Tenant ID</dt>
                <dd className="max-w-[200px] truncate font-mono text-xs text-muted-foreground text-right" title={profile.tenant.id}>
                  {profile.tenant.id}
                </dd>
              </div>
            </dl>
          </div>
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Your account</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Email</dt>
                <dd className="font-medium text-foreground text-right break-all">{profile.user.email}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="text-foreground text-right">{profile.user.fullName || '—'}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Role</dt>
                <dd className="capitalize text-foreground text-right">{profile.user.role.toLowerCase()}</dd>
              </div>
            </dl>
          </div>
        </div>
        </div>
      )}
    </div>
  );
}
