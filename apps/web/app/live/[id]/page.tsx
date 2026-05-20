import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getServerApiBaseUrl } from '@/lib/server-api-base';

export const dynamic = 'force-dynamic';

type PublicAgentLive = {
  name: string;
  storeName: string | null;
  status: string;
  isActive: boolean;
  language: string;
  phone: string | null;
  greeting: string | null;
};

async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? '127.0.0.1:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

/** Prefer same-origin proxy (reliable in dev); fall back to direct API. */
async function fetchPublicAgent(id: string): Promise<PublicAgentLive | null> {
  const safeId = encodeURIComponent(id);
  let res = await fetch(`${await requestOrigin()}/api/public/agents/${safeId}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!res.ok && res.status !== 404) {
    res = await fetch(`${getServerApiBaseUrl()}/api/public/agents/${safeId}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
  }
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json() as Promise<PublicAgentLive>;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const agent = await fetchPublicAgent(id);
  if (!agent) return { title: 'Agent' };
  return {
    title: `${agent.name} · Voice agent`,
    description: agent.storeName
      ? `Call ${agent.name} for ${agent.storeName}.`
      : `Contact ${agent.name} by phone.`,
  };
}

function statusMessage(isActive: boolean, status: string) {
  if (isActive) return { label: 'Live', detail: 'This voice agent is on and can take calls.' };
  if (status === 'PAUSED') return { label: 'Paused', detail: 'Calls are temporarily paused. Try again later.' };
  if (status === 'DISABLED') return { label: 'Unavailable', detail: 'This agent is not available.' };
  return { label: 'Not live yet', detail: 'This agent is still in draft. The owner can activate it from the dashboard.' };
}

export default async function LiveAgentPublicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await fetchPublicAgent(id);
  if (!agent) notFound();

  const { label, detail } = statusMessage(agent.isActive, agent.status);
  const tel = agent.phone?.replace(/\s/g, '') ?? '';

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-50 to-white text-zinc-900 dark:from-zinc-950 dark:to-zinc-900 dark:text-zinc-50">
      <div className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
          Voice agent
        </p>
        <h1 className="mt-3 text-center text-3xl font-semibold tracking-tight">{agent.name}</h1>
        {agent.storeName ? (
          <p className="mt-2 text-center text-lg text-zinc-600 dark:text-zinc-300">{agent.storeName}</p>
        ) : null}

        <div
          className={`mt-8 rounded-2xl border px-4 py-3 text-center text-sm ${
            agent.isActive
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
              : 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-200'
          }`}
        >
          <span className="font-medium">{label}</span>
          <span className="mt-1 block text-xs opacity-90">{detail}</span>
        </div>

        {agent.greeting ? (
          <blockquote className="mt-8 border-l-4 border-zinc-300 pl-4 text-sm leading-relaxed text-zinc-600 dark:border-zinc-600 dark:text-zinc-300">
            {agent.greeting}
          </blockquote>
        ) : null}

        {agent.isActive && tel ? (
          <a
            href={`tel:${tel}`}
            className="mt-10 flex h-14 items-center justify-center rounded-xl bg-zinc-900 text-base font-semibold text-white shadow-lg transition hover:bg-zinc-800 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
          >
            Call {agent.phone}
          </a>
        ) : agent.phone ? (
          <p className="mt-10 text-center text-sm text-zinc-500 dark:text-zinc-400">Phone: {agent.phone}</p>
        ) : (
          <p className="mt-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
            No phone number is published for this agent yet.
          </p>
        )}

        <p className="mt-8 text-center text-xs text-zinc-400 dark:text-zinc-500">Language: {agent.language}</p>

        <p className="mt-12 text-center text-xs text-zinc-400 dark:text-zinc-500">
          Powered by your store&apos;s AI voice assistant.
        </p>
        <div className="mt-6 text-center">
          <Link href="/" className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:hover:text-zinc-300">
            Admin sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
