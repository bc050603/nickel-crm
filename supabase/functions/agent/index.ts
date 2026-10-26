// Supabase Edge Function「agent」：客户参谋。回答“今天找谁询价”“谁很久没聊了”这类问题。
// 每次按登录用户读取全部客户、最近记录和情报（行级权限生效），交给 OpenAI 回答。
// 需要的 Secrets：OPENAI_API_KEY、OPENAI_MODEL
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODES = ["询价", "日常闲聊", "分享观点", "约见面", "回访跟进"];
const DEFAULT_CAD: Record<string, number> = { A: 3, B: 7, C: 30 };

function clientFor(req: Request) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  return createClient(url, key, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

async function askOpenAI(messages: { role: string; content: string }[]) {
  const key = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL");
  if (!key) throw new Error("Supabase 里还没设置 OPENAI_API_KEY");
  if (!model) throw new Error("Supabase 里还没设置 OPENAI_MODEL");
  const body: Record<string, unknown> = { model, messages, response_format: { type: "json_object" } };
  const call = () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let r = await call();
  let data = await r.json().catch(() => null);
  if (!r.ok && /response_format/i.test(data?.error?.message ?? "")) {
    delete body.response_format;
    r = await call();
    data = await r.json().catch(() => null);
  }
  if (!r.ok) throw new Error(data?.error?.message ?? `OpenAI 返回 ${r.status}`);
  return String(data?.choices?.[0]?.message?.content ?? "");
}

function parseJson(text: string) {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
const addDays = (s: string, n: number) => new Date(Date.parse(s) + n * 864e5).toISOString().slice(0, 10);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const sb = clientFor(req);
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return json({ error: "请先登录" }, 401);

  let input: { messages?: { role: string; content: string }[] } = {};
  try { input = await req.json(); } catch { return json({ error: "请求格式不对" }, 400); }
  const turns = (input.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "缺少问题" }, 400);

  const [cs, logs, intel, settings] = await Promise.all([
    sb.from("contacts").select("id,name,company,role,segment,relation,tier,gives,wants,next_note,next_due,last_touch,last_their").limit(1000),
    sb.from("logs").select("contact_name,date,channel,summary,next").order("date", { ascending: false }).limit(40),
    sb.from("intel").select("contact_name,date,category,content").order("date", { ascending: false }).limit(40),
    sb.from("settings").select("cadence").maybeSingle(),
  ]);
  const cad = { ...DEFAULT_CAD, ...(settings.data?.cadence ?? {}) } as Record<string, number>;
  const t = today();
  const contacts = cs.data ?? [];
  const table = contacts.map((c) => {
    const last = c.last_touch ?? c.last_their;
    const ago = last ? `${last}（${days(t, last)}天前）` : "从未回复";
    const due = c.next_due ?? (c.tier !== "D" && cad[c.tier] ? (last ? addDays(last, cad[c.tier]) : t) : null);
    const dueTxt = !due ? "不提醒" : days(t, due) > 0 ? `超期${days(t, due)}天` : days(t, due) === 0 ? "今天到期" : `${-days(t, due)}天后到期`;
    return [c.id, c.name, clip(c.company, 18), c.tier, c.relation ?? "", clip(c.segment, 10), ago, dueTxt,
      "能给:" + clip(c.gives, 60), "想要:" + clip(c.wants, 40), c.next_note ? "下次:" + clip(c.next_note, 30) : ""].join(" | ");
  }).join("\n");

  const system = `你是 Bruce（周宗信）的客户参谋。Bruce 是上海有色网（SMM）马来西亚办公室的镍、NPI、不锈钢分析师，目标是从客户那里拿到一手市场信息，并且和客户成为朋友。
今天是 ${t}。联系节奏：A 级每 ${cad.A} 天、B 级每 ${cad.B} 天、C 级每 ${cad.C} 天，D 级不提醒。

下面是 Bruce 的全部客户，一行一位，字段用 | 分隔：id | 名字 | 公司 | 分级 | 关系 | 产业链 | 上次聊过 | 到期情况 | 能给 | 想要 | 下次跟进
${table}

最近 40 条往来记录：
${(logs.data ?? []).map((l) => `- ${l.date} ${l.contact_name ?? ""} ${l.channel ?? ""}：${clip(l.summary, 80)}${l.next ? `（下次：${clip(l.next, 30)}）` : ""}`).join("\n") || "（暂无）"}

最近 40 条情报：
${(intel.data ?? []).map((i) => `- ${i.date} [${i.category}] ${clip(i.content, 90)}（来源：${i.contact_name ?? "未注明"}）`).join("\n") || "（暂无）"}

回答规则：
- 用中文，口语、直接，像一个懂行的同事。先给结论，再分点说明，每点一行，别写长段落。
- 推荐联系人时只能从上面的客户里选，说清楚为什么找他、聊什么、用哪种方式开口（询价、日常闲聊、分享观点、约见面、回访跟进）。
- 涉及价格和成交时，引用情报里的原话和日期；没有依据就直说不知道，不要编。
- 只回复 JSON：{"reply":"给 Bruce 看的回答","contacts":[{"id":"客户id","why":"一句话理由","mode":"询价"}]}。contacts 最多 8 个，按优先级排；没有要推荐的人就给空数组。`;

  try {
    const out = parseJson(await askOpenAI([{ role: "system", content: system }, ...turns]));
    if (!out || typeof out.reply !== "string") return json({ error: "这次没答出来，再问一次" }, 502);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const picks = (Array.isArray(out.contacts) ? out.contacts : [])
      .filter((p: any) => p && byId.has(p.id))
      .slice(0, 8)
      .map((p: any) => ({ id: p.id, name: byId.get(p.id)!.name, why: clip(p.why, 80), mode: MODES.includes(p.mode) ? p.mode : "询价" }));
    return json({ reply: out.reply, contacts: picks });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
