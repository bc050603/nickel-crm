// Supabase Edge Function「callnote」：把一通电话的转写整理成一条记录：要点、市场情报、下次跟进。
// 只返回结果，不写数据库；网页让 Bruce 改完确认后再保存。需要的 Secrets：OPENAI_API_KEY、OPENAI_MODEL
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const CATS = ["NPI/镍铁", "不锈钢", "纯镍/LME", "印尼政策/矿", "MHP/高冰/新能源", "废钢/铬", "海外/贸易", "其他"];
const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return json({ error: "请先登录" }, 401);

  let input: { contactId?: string; transcript?: string; plain?: string; date?: string } = {};
  try { input = await req.json(); } catch { return json({ error: "请求格式不对" }, 400); }
  const transcript = String(input.transcript ?? "").trim().slice(0, 20000);
  const plain = String(input.plain ?? "").trim().slice(0, 20000); // 同一通电话不分说话人、但字更准的版本
  if (!transcript) return json({ error: "转写是空的" }, 400);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(input.date ?? "") ? input.date! : today();
  // 往后两周的日期表：模型自己推“下周三”常常算错，让它照表查
  const base = Date.parse(day + "T00:00:00Z"), dow = new Date(base).getUTCDay() || 7;
  const cal = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(base + (i + 1) * 864e5), wk = dow + i + 1 <= 7 ? "本" : dow + i + 1 <= 14 ? "下" : "下下";
    return `${d.toISOString().slice(0, 10)}${i === 0 ? " 明天" : i === 1 ? " 后天" : ""} ${wk}${WEEK[d.getUTCDay()]}`;
  }).join("\n");

  const key = Deno.env.get("OPENAI_API_KEY"), model = Deno.env.get("OPENAI_MODEL");
  if (!key || !model) return json({ error: "Supabase 里还没设置 OPENAI_API_KEY 或 OPENAI_MODEL" }, 500);

  const { data: c } = input.contactId
    ? await sb.from("contacts").select("name,company,role,gives,wants").eq("id", input.contactId).maybeSingle()
    : { data: null };
  const who = c ? `「${c.name}」${c.company ? `（${c.company}${c.role ? "，" + c.role : ""}）` : ""}` : "一位客户";
  const ctx = c ? [c.gives && `平时能给的信息：${clip(c.gives, 120)}`, c.wants && `他想从 Bruce 这里要的：${clip(c.wants, 80)}`].filter(Boolean).join("\n") : "";

  const prompt = `下面是镍和不锈钢分析师 Bruce（SMM 马来西亚）和${who}一通电话的机器转写。
${ctx}
转写可能有错字、同音字和断句问题。行业词按常识纠正（比如“年铁”是“镍铁”，“聂点”是“镍点”），但不要补出转写里没有的内容。
转写如果按说话人分了行（“说话人1：”“说话人2：”），那是机器按声音分的，偶尔会分错。先判断每个说话人是 Bruce 还是客户（Bruce 是 SMM 的分析师，一般是他自报家门、问价、说要发报告），写进 speakers。没分说话人的，就按内容判断哪些话是客户说的。
这通电话是 ${day}（${WEEK[new Date(day + "T00:00:00Z").getUTCDay()]}）打的。

整理成下面四样：

1. points：这通电话的要点，3 到 6 条，最重要的放第一条。每条一句话，写给 Bruce 自己以后翻看。客户提到的个人近况（出差、家里、换岗位、身体、爱好）单独写一条，以“近况：”开头，下次聊天用得上。

2. intel：客户说出来的市场情报，价格、成交、报价、意向、排产、减产、库存、出货、政策、进出口、项目动态。每条要单独拿出来也能看懂，写成一句完整的话，按这个顺序把能确定的信息写全：
   主体（哪家公司、钢厂、贸易商、国家或地区，没说就写“客户”，不要编）→ 品种和规格（比如 NPI 含镍 11-12%、304 冷轧、MHP）→ 发生了什么 → 数字和单位（价格口径：到厂、舱底、FOB、CIF；元/镍点或美元/镍点、元/吨、吨数、时间）。
   规则：
   - 同一件事前后说了几次，合并成一条。
   - 只收客户说的，或客户明确确认过的；Bruce 自己说的、问的不算。
   - 客户的判断和看法也可以收，以“观点：”开头，写清楚是对什么的看法。
   - 保留原来的数字，不要换算。补全以后还是看不懂的，就不要这条。没有就给空数组。
   - 转写可能把币种、口径听错。币种和口径对不上常识时（比如“美元/镍点到厂”），照原文写，并在这条末尾加“（待核对）”。
   - 有两份转写时，同一个数字两份说法不一样，或者数字明显不像（比如“E0.30”），写最合理的那个，并在末尾加“（待核对：另一份听成 X）”。
   - category 只能从这里选：${CATS.join("、")}。

3. next：下次要跟进的事，比如 Bruce 答应发的东西、客户要的数据、约好再聊的话题。没有就写空字符串。

4. nextDate：如果说定了哪天再联系（比如“下周三再打给你”），从下面的日期表里查出 YYYY-MM-DD；没说定就给 null。
${cal}

${plain ? `转写一（按说话人分了行，用来判断谁说的，字可能不准）：
${transcript}

转写二（同一通电话，没分说话人，但字更准；数字、品名、公司名以这份为准）：
${plain}` : `转写：
${transcript}`}

只回复 JSON：{"speakers":{"说话人1":"Bruce","说话人2":"客户"},"points":["要点"],"intel":[{"category":"品类","content":"情报内容"}],"next":"","nextDate":null}
speakers 的值只能是 Bruce、客户、其他；转写没分说话人就给 {}。`;

  const body: Record<string, unknown> = { model, messages: [{ role: "user", content: prompt }], response_format: { type: "json_object" } };
  const call = () => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let r = await call();
  let data = await r.json().catch(() => null);
  if (!r.ok && /response_format/i.test(data?.error?.message ?? "")) { delete body.response_format; r = await call(); data = await r.json().catch(() => null); }
  if (!r.ok) return json({ error: data?.error?.message ?? `OpenAI 返回 ${r.status}` }, 502);

  const text = String(data?.choices?.[0]?.message?.content ?? "");
  let out: any = null;
  try { out = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(m[0]); } catch { /* ignore */ } } }
  if (!out) return json({ error: "这次没整理出来，再试一次" }, 502);

  const points = (Array.isArray(out.points) ? out.points : [])
    .map((p: unknown) => clip(p, 200)).filter(Boolean).slice(0, 8);
  const intel = (Array.isArray(out.intel) ? out.intel : [])
    .filter((i: any) => i && typeof i.content === "string" && i.content.trim())
    .slice(0, 10)
    .map((i: any) => ({ category: CATS.includes(i.category) ? i.category : "其他", content: clip(i.content, 300) }));
  const nextDate = /^\d{4}-\d{2}-\d{2}$/.test(out.nextDate ?? "") && out.nextDate >= day ? out.nextDate : null;
  const speakers: Record<string, string> = {};
  if (out.speakers && typeof out.speakers === "object") {
    for (const [k, v] of Object.entries(out.speakers)) if (/^说话人/.test(k) && ["Bruce", "客户", "其他"].includes(String(v))) speakers[k] = String(v);
  }
  return json({ speakers, points, intel, next: clip(out.next, 200), nextDate });
});
