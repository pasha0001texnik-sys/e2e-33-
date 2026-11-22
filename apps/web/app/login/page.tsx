import { Logo } from "@/components/Logo";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "Вход" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo />
          <div>
            <div className="text-lg font-semibold tracking-tight">E2E Hub</div>
            <div className="text-xs text-ink-3">автотесты онбординга на тестовых стендах</div>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-panel p-6 shadow-2xl shadow-black/40">
          {error && <p className="mb-4 text-sm text-bad">Не удалось войти: {error}</p>}
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
