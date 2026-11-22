import { redirect } from "next/navigation";
import { ROLES, type Profile } from "@e2e/shared";
import { PageHeader } from "@/components/ui";
import { requireUser, roleAtLeast } from "@/lib/auth";
import { fmtDate } from "@/lib/format";
import { RoleSelect } from "./RoleSelect";

export const metadata = { title: "Пользователи" };

export default async function UsersPage() {
  const { supabase, profile, user } = await requireUser();
  if (!roleAtLeast(profile.role, "admin")) redirect("/runs");
  const { data } = await supabase.from("profiles").select("*").order("created_at");

  return (
    <>
      <PageHeader
        title="Пользователи"
        subtitle="Наблюдатель видит прогоны; QA-инженер запускает и разбирает; администратор управляет стендами, сюитами и секретами."
      />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Роль</th>
              <th>Зарегистрирован</th>
            </tr>
          </thead>
          <tbody>
            {((data ?? []) as Profile[]).map((p) => (
              <tr key={p.id}>
                <td>
                  {p.email}
                  {p.id === user.id && <span className="ml-2 text-xs text-ink-3">это вы</span>}
                </td>
                <td>
                  <RoleSelect userId={p.id} role={p.role} roles={[...ROLES]} disabled={p.id === user.id} />
                </td>
                <td className="text-ink-3">{fmtDate(p.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
