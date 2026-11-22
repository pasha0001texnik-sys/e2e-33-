import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { NewRunForm } from "./NewRunForm";

export const metadata = { title: "Новый прогон" };

export default async function NewRunPage({ searchParams }: { searchParams: Promise<{ suite?: string; stand?: string }> }) {
  const { supabase, profile } = await requireUser();
  if (!roleAtLeast(profile.role, "qa")) redirect("/runs");
  const sp = await searchParams;
  const [{ data: suites }, { data: stands }] = await Promise.all([
    supabase.from("suites").select("id, name, slug, scenario_keys, default_parallelism, max_retries").order("name"),
    supabase.from("stands").select("id, slug, name, env, max_concurrency, is_active").eq("is_active", true).order("slug"),
  ]);
  return (
    <>
      <PageHeader title="Новый прогон" subtitle="Прогон встанет в очередь и стартует, когда на стенде освободятся потоки" />
      <NewRunForm suites={suites ?? []} stands={stands ?? []} defaults={sp} />
    </>
  );
}
