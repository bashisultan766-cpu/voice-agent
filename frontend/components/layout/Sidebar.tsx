"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BotMessageSquare, Phone, Settings, LogOut, LayoutDashboard } from "lucide-react";
import { clearSession, getStoredTenant } from "@/lib/auth";
import clsx from "clsx";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/agents", label: "Agents", icon: BotMessageSquare },
  { href: "/dashboard/calls", label: "Call Logs", icon: Phone },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const tenant = getStoredTenant();

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  return (
    <aside className="w-60 flex-shrink-0 bg-white border-r border-gray-100 flex flex-col h-screen sticky top-0">
      <div className="p-5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <BotMessageSquare className="text-brand-500" size={22} />
          <span className="font-bold text-gray-900 text-sm">Voice Agents</span>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-1">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              className={clsx(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-brand-50 text-brand-600"
                  : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
              )}
            >
              <Icon size={17} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-gray-100">
        {tenant && (
          <div className="px-3 py-2 mb-1">
            <p className="text-xs font-medium text-gray-900 truncate">{tenant.name}</p>
            <p className="text-xs text-gray-400 truncate">{tenant.email}</p>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-50 w-full transition-colors"
        >
          <LogOut size={17} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
