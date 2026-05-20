'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function PublicAgentLinkShare({ agentId }: { agentId: string }) {
  const [fullUrl, setFullUrl] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setFullUrl(`${window.location.origin}/live/${agentId}`);
  }, [agentId]);

  const copy = async () => {
    if (!fullUrl) return;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Customer-facing page</h2>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
        Share this link on your site or social — visitors see your store name, call button, and whether the voice agent is
        active. No login required.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <code className="block flex-1 truncate rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground">
          {fullUrl || `/live/${agentId}`}
        </code>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!fullUrl}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {copied ? 'Copied' : 'Copy link'}
          </button>
          <Link
            href={`/live/${agentId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded-lg border border-border bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90"
          >
            Open page
          </Link>
        </div>
      </div>
    </div>
  );
}
