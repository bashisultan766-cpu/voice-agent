import { DashboardSidebar } from '@/components/dashboard/DashboardSidebar';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { SessionCookieSync } from '@/components/dashboard/SessionCookieSync';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen min-w-0 overflow-x-hidden">
      <SessionCookieSync />
      <DashboardSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <DashboardHeader />
        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
