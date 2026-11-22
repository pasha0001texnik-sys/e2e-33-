import { notFound } from "next/navigation";
import type { Run, RunLog, RunStep, RunTest } from "@e2e/shared";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { RunLive } from "./RunLive";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Прогон ${id.slice(0, 8)}` };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase, profile } = await requireUser();

  const { data: run } = await supabase
    .from("runs")
    .select("*, suite:suites(name, slug), stand:stands(slug, name, env, base_url)")
    .eq("id", id)
    .single();
  if (!run) notFound();

  const [{ data: tests }, { data: steps }, { data: logs }] = await Promise.all([
    supabase.from("run_tests").select("*").eq("run_id", id).order("created_at"),
    supabase.from("run_steps").select("*").eq("run_id", id).order("id"),
    supabase.from("run_logs").select("*").eq("run_id", id).order("id", { ascending: false }).limit(500),
  ]);

  return (
    <RunLive
      initial={{
        run: run as Run & { suite: { name: string; slug: string }; stand: { slug: string; name: string; env: string; base_url: string } },
        tests: (tests ?? []) as RunTest[],
        steps: (steps ?? []) as RunStep[],
        logs: ((logs ?? []) as RunLog[]).reverse(),
      }}
      canOperate={roleAtLeast(profile.role, "qa")}
    />
  );
}
