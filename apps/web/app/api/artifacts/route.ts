import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Короткоживущая ссылка на артефакт прогона (скриншот, DOM, трейс).
// Бакет приватный; доступ проверяется политикой storage для вошедших пользователей.
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path");
  const download = request.nextUrl.searchParams.get("download") === "1";
  if (!path || path.includes("..")) return NextResponse.json({ error: "bad path" }, { status: 400 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabase.storage.from("artifacts").createSignedUrl(path, 300, download ? { download: true } : undefined);
  if (error || !data) return NextResponse.json({ error: error?.message ?? "not found" }, { status: 404 });
  return NextResponse.redirect(data.signedUrl, { status: 302 });
}
