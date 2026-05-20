import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-muted-foreground">
        The page you’re looking for doesn’t exist or has been moved.
      </p>
      <div className="mt-6 flex gap-4">
        <Link
          href="/"
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700"
        >
          Home
        </Link>
        <Link
          href="/dashboard"
          className="rounded-md border border-gray-300 px-4 py-2 hover:bg-gray-100"
        >
          Dashboard
        </Link>
      </div>
    </main>
  );
}
