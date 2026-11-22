import { Logo } from "@/components/Logo";
import { NavLinks } from "@/components/NavLinks";
import { QueryProvider } from "@/components/QueryProvider";
import { requireUser, roleAtLeast } from "@/lib/auth";

const ROLE_LABEL = { viewer: "наблюдатель", qa: "QA-инженер", admin: "администратор" } as const;

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireUser();
  const isAdmin = roleAtLeast(profile.role, "admin");

  const nav = [
    { href: "/runs", label: "Прогоны" },
    { href: "/schedules", label: "Расписания" },
    { href: "/fixtures", label: "Фикстуры" },
    { href: "/suites", label: "Сюиты" },
    { href: "/stands", label: "Стенды" },
    ...(isAdmin
      ? [
          { href: "/users", label: "Пользователи" },
          { href: "/audit", label: "Аудит" },
        ]
      : []),
  ];

  return (
    <QueryProvider>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-line bg-panel/60 px-3 py-4 md:flex">
          <div className="mb-6 flex items-center gap-2 px-2">
            <div className="scale-75">
              <Logo />
            </div>
            <span className="font-semibold tracking-tight">E2E Hub</span>
          </div>
          <NavLinks items={nav} />
          <div className="mt-auto border-t border-line px-2 pt-4">
            <div className="truncate text-sm">{profile.display_name || profile.email}</div>
            <div className="text-xs text-ink-3">{ROLE_LABEL[profile.role]}</div>
            <form action="/auth/signout" method="post" className="mt-3">
              <button className="text-xs text-ink-3 hover:text-ink">Выйти</button>
            </form>
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <div className="border-b border-line px-4 py-3 md:hidden">
            <NavLinks items={nav} horizontal />
          </div>
          <main className="mx-auto max-w-7xl px-4 py-8 md:px-8">{children}</main>
        </div>
      </div>
    </QueryProvider>
  );
}
