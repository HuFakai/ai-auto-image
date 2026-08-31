"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/admin", label: "概览" },
  { href: "/admin/users", label: "用户" },
  { href: "/admin/orders", label: "订单" },
  { href: "/admin/plans", label: "套餐" },
  { href: "/admin/channels", label: "模型渠道" },
  { href: "/admin/payments", label: "支付渠道" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="mt-5 flex flex-wrap gap-1.5 border-b border-line pb-3">
      {ITEMS.map((item) => {
        const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`rounded-lg px-3.5 py-1.5 font-mono text-xs transition-colors ${
              active ? "bg-[#2a201c] text-seal" : "text-ink-faint hover:bg-[#241f1b] hover:text-ink"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
