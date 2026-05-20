'use client';

import Link from 'next/link';
import { VoiceIntegrationsTestPanel } from '@/components/settings/VoiceIntegrationsTestPanel';

const links = [
  { href: '/dashboard/settings/integrations/shopify', label: 'Shopify', description: 'Connect storefront and admin access.' },
  { href: '/dashboard/settings/integrations/twilio', label: 'Twilio', description: 'Connect telephony and call webhooks.' },
  { href: '/dashboard/settings/integrations/openai', label: 'OpenAI', description: 'Connect reasoning and fallback voice.' },
  { href: '/dashboard/settings/integrations/email', label: 'Email (Resend)', description: 'Enable checkout and support emails.' },
  {
    href: '/dashboard/settings/integrations/elevenlabs',
    label: 'ElevenLabs',
    description: 'Configure premium workspace voice output.',
  },
];

export function IntegrationsClient() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/dashboard/settings" className="text-sm text-violet-600 hover:underline dark:text-violet-400">
        ← Settings
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open each integration to test, save, and verify workspace credentials.
        </p>
      </div>
      <VoiceIntegrationsTestPanel />
      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="block rounded-xl border border-border bg-card p-4 shadow-sm hover:bg-muted"
            >
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{item.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
