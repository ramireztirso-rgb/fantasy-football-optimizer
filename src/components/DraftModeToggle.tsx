"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The two ways of watching a draft, one tap apart.
 *
 * They are the same board fed two different ways -- ESPN's feed against
 * hand-tracked picks -- and on draft night you may need to move between them
 * fast, since the feed being alive is not knowable until the room opens.
 */
export function DraftModeToggle() {
  const pathname = usePathname();
  const tabs = [
    { href: "/draft", label: "Live board", hint: "ESPN's feed (or the practice room)" },
    { href: "/draft/manual", label: "Manual tracking", hint: "you tap the picks" },
  ];
  return (
    <div className="flex items-center gap-1 rounded-xl border border-pitch-700 bg-pitch-900/60 p-1">
      {tabs.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            title={tab.hint}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              active
                ? "bg-pitch-700 text-chalk-100"
                : "text-chalk-400 hover:bg-pitch-800 hover:text-chalk-200"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
