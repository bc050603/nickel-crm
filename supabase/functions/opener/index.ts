// Supabase Edge Function「opener」：按场景、用 Bruce 的说话方式写 3-4 个开场白选项。
// 数据在服务端按登录用户读取（行级权限生效），OpenAI key 只在 Secrets 里。
// 需要的 Secrets：OPENAI_API_KEY、OPENAI_MODEL
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MODES: Record<string, string> = {
  "询价": "目标是拿到一手的价格、成交、排产或库存。先亮牌：报一个你听到的具体数字或成交，再请他确认、纠正或给个判断。按他的岗位问他答得上的问题（采购问接受价，销售问报价和走货，贸易商问成交和情绪，仓库问出入库）。",
  "日常闲聊": "目标是像朋友一样维系关系，这次不问价。接他以前聊过的生活话题、关心近况、开个玩笑，或者聊一个轻松的行业八卦。",
  "分享观点": "目标是先给价值：用一两句说 Bruce 对最近一条市场消息的判断，再问他怎么看。",
  "约见面": "目标是约电话、喝咖啡或见面。给一个具体理由和时间窗口（出差、展会、路过），让他好答应。",
  "回访跟进": "目标是接住上次聊的事（看记录和“下次跟进”），问进展或结果，让他知道你记得。",
};

const SHAREABLE = ["NPI/镍铁", "不锈钢", "纯镍/LME", "印尼政策/矿", "MHP/高冰/新能源", "废钢/铬", "海外/贸易"];
const DEFAULT_PROFILE = "短句、口语，常带“呀、哈、嘛、啦、滴”这类语气词，常用“好滴、嗯嗯、确实、哈哈哈”；称呼X总，熟的叫哥、姐；偶尔一个表情如[捂脸][抱拳]；绝不用客服腔。";
const DEFAULT_PROFILE_EN = "英文（WhatsApp）：很短，一条中位数 5 个词，一件事拆几条发，句尾大多不加标点；开场 “Morning Pak X” “Hey X!” “Hi Mr X, Bruce here”；常用 alright、yup、sure、noted、no worries、btw、tho、haha、bro；问价先说听到的 “I heard … at …”；表情很少，常用 🤣 😭 🙏；不用 Dear、Kindly、Regards 这种邮件腔。";
// 拉丁字母占比：判断一句话是英文（含印尼/马来文）还是中文
const latin = (s: string) => { const l = (s.match(/[A-Za-z]/g) ?? []).length, z = (s.match(/[一-鿿]/g) ?? []).length; return l / Math.max(1, l + z * 2); };

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

const shuffle = <T>(a: T[]) => a.map((x) => [Math.random(), x] as const).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const sb = clientFor(req);
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return json({ error: "请先登录" }, 401);

  let input: { contactId?: string; mode?: string; note?: string } = {};
  try { input = await req.json(); } catch { return json({ error: "请求格式不对" }, 400); }
  const mode = MODES[input.mode ?? ""] ? input.mode! : "询价";
  const note = String(input.note ?? "").slice(0, 300);
  if (!input.contactId) return json({ error: "缺少客户" }, 400);

  const [c, logs, theirs, market, examples, settings] = await Promise.all([
    sb.from("contacts").select("*").eq("id", input.contactId).maybeSingle(),
    sb.from("logs").select("date,channel,summary,next").eq("contact_id", input.contactId).order("date", { ascending: false }).limit(5),
    sb.from("intel").select("date,category,content").eq("contact_id", input.contactId).order("date", { ascending: false }).limit(5),
    // 别的客户给的情报只拿可以对外说的品类（市场价格、政策这类），“其他”里可能有别人的私事，不拿
    sb.from("intel").select("date,category,content").or(`contact_id.is.null,contact_id.neq.${input.contactId}`).in("category", SHAREABLE).order("date", { ascending: false }).limit(8),
    sb.from("style_examples").select("text,source").eq("category", mode).order("created_at", { ascending: false }).limit(500),
    sb.from("settings").select("style_profile").maybeSingle(),
  ]);
  const contact = c.data;
  if (!contact) return json({ error: "找不到这位客户" }, 404);

  // WhatsApp 客户多半用英文聊：语言看导入时记的 stats.lang，没有就看 Bruce 以前跟他说的话
  const stats = contact.stats ?? {};
  const platform = stats.platform === "WhatsApp" || stats.platform === "LinkedIn" ? stats.platform : "微信";
  const samples: string[] = contact.my_samples ?? [];
  const en = stats.lang ? stats.lang !== "zh" : samples.filter((t) => latin(t) > 0.6).length > samples.length / 2;
  const ex = (examples.data ?? []).filter((e) => (latin(e.text) > 0.6) === en);
  const learned = ex.filter((e) => !/导入$/.test(e.source)).slice(0, 8);
  const imported = shuffle(ex.filter((e) => /导入$/.test(e.source))).slice(0, 10);
  const lines = (rows: Record<string, unknown>[] | null, f: (r: any) => string) => (rows && rows.length ? rows.map(f).join("\n") : "（暂无）");
  let profile = settings.data?.style_profile || DEFAULT_PROFILE;
  if (en && !/英文|WhatsApp/.test(profile)) profile += "\n" + DEFAULT_PROFILE_EN;

  const prompt = `你在替 Bruce（周宗信）写一条要发给客户的${platform}消息。Bruce 是上海有色网（SMM）马来西亚办公室的镍、高镍生铁（NPI）、不锈钢分析师，二十多岁，马来西亚华人。他的目标是从客户那里拿到一手市场信息，并且和客户成为朋友。

【语言】
${en ? "用英文写，照 Bruce 平时跟这位客户的英文口吻（看下面他说过的话和例句）。对方是印尼人可以称 Pak/Bu，偶尔夹一两个印尼语词也行。不要写中文，也不要用微信表情代码（比如 [捂脸]）。下面的资料和情报是中文，用到时翻成自然的英文。" : "用中文写。"}

${platform === "LinkedIn" ? `【渠道：LinkedIn 私信】
对方多半只在 LinkedIn 上加了好友，还没跟 Bruce 聊过。第一条先用一句话说清楚自己是谁（SMM 的镍和不锈钢分析师）和为什么找他，再给一个对他有用的东西（一个数字、一个判断、一份报告），最后问一个他容易回答的问题。比微信、WhatsApp 正式一点，但不要写成邮件：不用 Dear、Regards，不用表情，不要群发腔。“下次跟进”里如果有现成的草稿，参考它的角度但写得更像 Bruce；如果写着还在等对方通过好友邀请，就写通过后的第一条。
` : ""}
【Bruce 的说话习惯】
${profile}

【Bruce 以前真的跟这位客户说过的话】（照着这个称呼、熟悉程度和语气写）
${(contact.my_samples ?? []).slice(-10).map((t: string) => "- " + t).join("\n") || "（暂无，按一般客户的熟悉程度写）"}

【Bruce 在「${mode}」时的真实例句】（模仿用词和节奏，不要照抄内容）
${[...learned, ...imported].map((e) => "- " + e.text).join("\n") || "（暂无）"}

【这次的目的：${mode}】
${MODES[mode]}${note ? `\nBruce 补充：${note}` : ""}

【客户资料】
名字：${contact.name}；公司：${contact.company ?? "未知"}；角色：${contact.role ?? "未知"}；产业链：${contact.segment ?? ""}；关系：${contact.relation ?? ""}；分级：${contact.tier}
他能给的信息：${contact.gives ?? "未知"}
他想要的：${contact.wants ?? "未知"}
沟通提醒：${contact.issues ?? "无"}
上次聊过：${contact.last_touch ?? contact.last_their ?? "从未"}；下次跟进：${contact.next_note || contact.next || "无"}

【最近和他的记录】
${lines(logs.data, (l) => `- ${l.date} ${l.channel ?? ""}：${l.summary ?? ""}${l.next ? `（下次：${l.next}）` : ""}`)}

【他以前给过的情报】
${lines(theirs.data, (i) => `- ${i.date} [${i.category}] ${i.content}`)}

【Bruce 手上最新的市场情报】（可以拿来亮牌，只说内容，绝不提来源或成交方的名字）
${lines(market.data, (i) => `- ${i.date} [${i.category}] ${i.content}`)}

今天是 ${today()}。
写 4 个不同角度的选项。每个选项是 Bruce 可以直接复制发出的${platform}消息：口语，像他本人；最多 3 短句，可以拆成两条消息（用换行分开）；不要编号、引号、解释；不要说出任何成交方、买卖方或信息来源的名字；不提公司内部资料。
只回复 JSON：{"options":[{"label":"4到8个字说明这个角度","text":"消息内容"}]}`;

  try {
    const out = parseJson(await askOpenAI([{ role: "user", content: prompt }]));
    const options = (out?.options ?? [])
      .filter((o: any) => o && typeof o.text === "string" && o.text.trim())
      .slice(0, 4)
      .map((o: any) => ({ label: String(o.label ?? "").slice(0, 16), text: String(o.text).trim() }));
    if (!options.length) return json({ error: "这次没写出来，再试一次" }, 502);
    return json({ mode, options });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
