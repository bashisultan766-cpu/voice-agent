import { Suspense } from 'react';
import { LoginForm, LoginFormFallback } from './LoginForm';

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFormFallback />}>
      <LoginForm />
    </Suspense>
  );
}
