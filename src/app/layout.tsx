import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fantasy Football Optimizer",
  description: "Draft, waiver, and lineup decisions with the reasoning shown.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/lineup", label: "Lineup" },
  { href: "/waivers", label: "Waivers" },
  { href: "/draft", label: "Draft" },
  { href: "/scout", label: "Scout" },
  { href: "/league", label: "League" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="mx-auto max-w-7xl px-4 py-6">
          <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-pitch-700 pb-4">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Fantasy Football Optimizer</h1>
              <p className="text-sm text-chalk-500">Every recommendation shows its work.</p>
            </div>
            <nav className="flex gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-lg px-3 py-2 text-sm text-chalk-300 transition hover:bg-pitch-800 hover:text-chalk-100"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
