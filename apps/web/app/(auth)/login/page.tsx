import { Suspense } from 'react';
import { LoginForm, LoginFormFallback } from './LoginForm';

type LoginPageProps = {
  searchParams: Promise<{ reason?: string }>;
};

/**
 * Server page: reads query string (Next.js 15 async searchParams) and passes
 * flags into the client form so we avoid useSearchParams() CSR bailout issues.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { reason } = await searchParams;
  const sessionExpired = reason === 'session-expired';

  return (
    <Suspense fallback={<LoginFormFallback />}>
      <LoginForm sessionExpired={sessionExpired} />
    </Suspense>
  );
}
