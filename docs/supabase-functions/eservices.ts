// دالة Supabase الوسيطة «eservices»: صفحة الخدمات الإلكترونية في المنصة ← سكربت شيت OPD Services Responses
// المتصفح يكلّم Supabase فقط، وSupabase يكلّم سكربت قوقل من خوادمه (شبكة المستشفى تحجب قوقل).
// تتحقق من صلاحية eservices للمستخدم، ثم تمرر الطلب للسكربت بمفتاح سري.
// رابط السكربت والمفتاح السري في جدول opd_eservices_link (يُقرأ بمفتاح الخدمة المدمج في Supabase)
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });
const ACTIONS = ["list", "update", "msg", "search", "stats"];
const PUBLIC_KEY = "sb_publishable_f3IjPvIbMruO9jGb4SmT7Q_NOqgEbXs";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json({ ok: false, error: "not_signed_in" }, 401);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY") ?? PUBLIC_KEY, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const perm = await sb.rpc("opd_has_perm", { p: "eservices" });
  if (perm.error || perm.data !== true) return json({ ok: false, error: "not_authorized" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  if (!ACTIONS.includes(String(body.action))) return json({ ok: false, error: "unknown_action" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const link = await admin.from("opd_eservices_link").select("script_url, secret").eq("id", 1).maybeSingle();
  const url = link.data?.script_url, secret = link.data?.secret;
  if (!url || !secret) return json({ ok: false, error: "الربط مع سكربت الشيت غير مكتمل" }, 500);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...body, secret }),
      redirect: "follow",
      signal: AbortSignal.timeout(55000),
    });
    const text = await r.text();
    try { return json(JSON.parse(text)); }
    catch { return json({ ok: false, error: "رد غير متوقع من سكربت الشيت (" + r.status + ")" }, 502); }
  } catch (e) {
    return json({ ok: false, error: "تعذر الوصول لسكربت الشيت: " + String((e as Error)?.message ?? e) }, 502);
  }
});
