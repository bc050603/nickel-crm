// Supabase Edge Function「extract」：从一段客户微信对话里挑出市场情报（价格、成交、排产、库存、政策）。
// 只返回结果，不写数据库；由本机同步脚本写入。需要的 Secrets：OPENAI_API_KEY、OPENAI_MODEL
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const CATS = ["NPI/镍铁", "不锈钢", "纯镍/LME", "印尼政策/矿", "MHP/高冰/新能源", "废钢/铬", "海外/贸易", "其他"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return json({ error: "请先登录" }, 401);

  let input: { contactName?: string; messages?: { time: string; me: boolean; text: string }[] } = {};
  try { input = await req.json(); } catch { return json({ error: "请求格式不对" }, 400); }
  const msgs = (input.messages ?? []).filter((m) => m && typeof m.text === "string" && m.text.trim()).slice(-60);
  if (!msgs.length) return json({ items: [] });

  const key = Deno.env.get("OPENAI_API_KEY"), model = Deno.env.get("OPENAI_MODEL");
  if (!key || !model) return json({ error: "Supabase 里还没设置 OPENAI_API_KEY 或 OPENAI_MODEL" }, 500);

  const convo = msgs.map((m) => `${m.time} ${m.me ? "Bruce" : (input.contactName ?? "客户")}：${m.text.slice(0, 400)}`).join("\n");
  const prompt = `下面是镍和不锈钢分析师 Bruce 和客户「${input.contactName ?? ""}」最近的微信对话。
把客户说出来的市场情报挑出来：价格、成交（价、量、品位、交货）、报价、升贴水、排产、减产、库存、出货、招标、政策、项目动态。
规则：
- 只要客户说的，或客户明确确认过的；Bruce 自己说的不算。
- 闲聊、客套、没有信息量的不要。没有就返回空数组。
- 每条一句话，保留原来的数字、单位和说法，不要改写成别的数。日期用那条消息的日期。
- 品类只能从这里选：${CATS.join("、")}。

对话：
${convo}

只回复 JSON：{"items":[{"date":"YYYY-MM-DD","category":"品类","content":"情报内容"}]}`;

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
  const items = (Array.isArray(out?.items) ? out.items : [])
    .filter((i: any) => i && typeof i.content === "string" && i.content.trim())
    .slice(0, 8)
    .map((i: any) => ({
      date: /^\d{4}-\d{2}-\d{2}$/.test(i.date ?? "") ? i.date : null,
      category: CATS.includes(i.category) ? i.category : "其他",
      content: String(i.content).trim().slice(0, 300),
    }));
  return json({ items });
});
