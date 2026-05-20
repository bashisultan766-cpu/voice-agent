export const dynamic = 'force-dynamic';
import { TranscriptDetailClient } from '@/components/dashboard/ops/TranscriptDetailClient';

export default async function TranscriptPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  return <TranscriptDetailClient callId={callId} />;
}
