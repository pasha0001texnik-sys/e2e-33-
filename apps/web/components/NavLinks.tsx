"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items, horizontal }: { items: { href: string; label: string }[]; horizontal?: boolean }) {
  const path = usePathname();
  return (
    <nav className={horizontal ? "flex gap-1 overflow-x-auto" : "flex flex-col gap-0.5"}>
      {items.map((i) => {
        const active = path === i.href || path.startsWith(i.href + "/");
        return (
          <Link
            key={i.href}
            href={i.href}
            className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition ${
              active ? "bg-panel-2 font-medium text-ink" : "text-ink-2 hover:bg-panel-2/60 hover:text-ink"
            }`}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
