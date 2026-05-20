'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const nav = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/live', label: 'Web pages' },
  { href: '/dashboard/readiness', label: 'Pre-launch' },
  { href: '/dashboard/stores', label: 'Stores' },
  { href: '/dashboard/agents', label: 'Agents' },
  { href: '/dashboard/agents/health', label: 'Agent health' },
  { href: '/dashboard/knowledge', label: 'Knowledge' },
  { href: '/dashboard/calls', label: 'Calls' },
  { href: '/dashboard/transcripts', label: 'Transcripts' },
  { href: '/dashboard/checkout-links', label: 'Checkout links' },
  { href: '/dashboard/leads', label: 'Leads' },
  { href: '/dashboard/email-events', label: 'Email events' },
  { href: '/dashboard/analytics', label: 'Analytics' },
  { href: '/dashboard/qa', label: 'QA review' },
  { href: '/dashboard/settings', label: 'Settings' },
];

function isNavActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === '/dashboard') return pathname === '/dashboard';
  if (href === '/dashboard/agents') {
    if (pathname.startsWith('/dashboard/agents/health')) return false;
    return pathname.startsWith('/dashboard/agents');
  }
  if (href !== '/') return pathname.startsWith(`${href}/`);
  return false;
}

export function DashboardSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 border-r border-border bg-gradient-to-b from-indigo-950 via-slate-900 to-slate-900 text-slate-100">
      <div className="flex h-14 items-center border-b border-white/10 px-4">
        <span className="bg-gradient-to-r from-violet-600 to-indigo-600 bg-clip-text text-sm font-bold tracking-tight text-transparent">
          Voice Ops
        </span>
      </div>
      <nav className="flex flex-col gap-0.5 p-2">
        {nav.map((item) => {
          const active = isNavActive(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/25'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
