// Supabase Edge Function「agent」：客户参谋。回答“今天找谁询价”“谁很久没聊了”这类问题。
// 每次按登录用户读取全部客户、最近记录和情报（行级权限生效），交给 Claude 回答。
// 需要的 Secrets：ANTHROPIC_API_KEY；可选 CLAUDE_MODEL（不填用 claude-opus-5-5）
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";

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

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  reply: { type: "string" },
  contacts: { type: "array", items: obj({ id: { type: "string" }, name: { type: "string" }, why: { type: "string" }, mode: { type: "string", enum: MODES } }) },
});

// 问 Claude，回答按 schema 给 JSON。同一段对话里追问时，客户表那一大段走缓存，便宜也快一些
async function askClaude(system: string, messages: { role: "user" | "assistant"; content: string }[], schema: Record<string, unknown>) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Supabase 里还没设置 ANTHROPIC_API_KEY");
  const r = await new Anthropic({ apiKey }).beta.messages.create({
    model: Deno.env.get("CLAUDE_MODEL") || "claude-opus-5-5",
    max_tokens: 16000,
    system,
    messages,
    cache_control: { type: "ephemeral" },
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    // 万一被安全审核挡下，服务端自动换一个模型重答
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (r.stop_reason === "refusal") throw new Error("Claude 这次没答，换个问法再试");
  if (r.stop_reason === "max_tokens") throw new Error("回答太长被截断了，再问一次");
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
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
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content.slice(0, 2000) }));
  while (turns.length && turns[0].role !== "user") turns.shift(); // Claude 要求对话从用户开始
  if (!turns.length || turns[turns.length - 1].role !== "user") return json({ error: "缺少问题" }, 400);

  const [cs, logs, intel, settings] = await Promise.all([
    sb.from("contacts").select("id,name,company,role,segment,relation,tier,gives,wants,next_note,next_due,last_touch,last_their,stats").limit(1000),
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
    const s = c.stats ?? {}; // 渠道和语言：导入时记的，或者在客户卡「编辑」里选的
    const wa = s.platform === "WhatsApp" ? "（WhatsApp" + (s.lang === "zh" ? "" : "，英文") + "）"
      : s.platform === "LinkedIn" ? "（LinkedIn" + (s.lang && s.lang !== "zh" ? "，英文" : "") + "）" : s.lang && s.lang !== "zh" ? "（英文）" : "";
    return [c.id, c.name + wa, clip(c.company, 18), c.tier, c.relation ?? "", clip(c.segment, 10), ago, dueTxt,
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
- 名字相近的是不同的人（比如“周”和“周青”），公司以表里那一行为准，不要混在一起。
- 关系是“同事”的是 Bruce 自己公司的同事，不是客户，不要推荐。
- 标了（LinkedIn）的只在 LinkedIn 上加了好友、还没真正聊过，用 LinkedIn 私信联系，第一条要先介绍自己。
- 名字后面标了（WhatsApp）的客户在 WhatsApp 上联系，标了“英文”的用英文聊；推荐时说清楚。contacts 里的 name 不要带这个括号。
- reply 里提到的每一位推荐对象，都要放进 contacts。
- 只回复 JSON：{"reply":"给 Bruce 看的回答","contacts":[{"id":"原样复制表格第一列的 id","name":"名字","why":"一句话理由","mode":"询价"}]}。contacts 最多 8 个，按优先级排；没有要推荐的人就给空数组。`;

  try {
    const out = parseJson(await askClaude(system, turns, SCHEMA));
    if (!out || typeof out.reply !== "string") return json({ error: "这次没答出来，再问一次" }, 502);
    // 先按 id 对上；模型偶尔写错 id，就按名字找回同一个人
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const find = (p: any) => byId.get(String(p?.id ?? "").trim())
      ?? contacts.find((c) => c.name === p?.name)
      ?? contacts.find((c) => p?.name && (c.name.includes(p.name) || String(p.name).includes(c.name)));
    const seen = new Set<string>();
    const picks = (Array.isArray(out.contacts) ? out.contacts : [])
      .map((p: any) => ({ p, c: find(p) }))
      .filter(({ c }) => c && !seen.has(c.id) && seen.add(c.id))
      .slice(0, 8)
      .map(({ p, c }) => ({ id: c!.id, name: c!.name, why: clip(p.why, 80), mode: MODES.includes(p.mode) ? p.mode : "询价" }));
    return json({ reply: out.reply, contacts: picks });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
