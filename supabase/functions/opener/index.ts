// Supabase Edge Function「opener」：按场景、用 Bruce 的说话方式写 3-4 个开场白选项。
// 数据在服务端按登录用户读取（行级权限生效），Claude 的 key 只在 Secrets 里。
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
// LinkedIn 私信：分析师找同行交流，不是销售。没聊过的才自我介绍，发过介绍没回的写跟进
const LINKEDIN = `【渠道：LinkedIn 私信】（这一段优先于下面的「这次的目的」）
Bruce 在 LinkedIn 上是以分析师的身份找同行交流，不是销售。先看【最近和他的记录】，分三种情况写：
- 对方已经在 LinkedIn 上回过话、聊开了：接着他上次说的写，可以按「这次的目的」问问题，口吻还是同行之间。
- 对方发来的消息 Bruce 一直没回：先接住他那条，简单说声抱歉，不要编理由（比如出差、太忙），这一条不带市场信息、也不问价。
- Bruce 发过介绍或首条私信、对方没回：不要再自我介绍，写一条简短的跟进，找一个跟他工作相关的由头，问一句他的看法。
- 从没聊过：三句左右。先说自己是谁、研究什么（SMM 驻吉隆坡的镍和不锈钢分析师；从印尼镍矿、NPI、MHP 和高冰镍这类中间品、中国不锈钢、镍铁流向中国和印度、欧盟 CBAM 里挑跟对方相关的说）；再说为什么想听他的看法（他在产业链上的位置看得到 Bruce 研究需要的东西）；最后轻轻一句同行之间的邀请，比如 compare notes、swap views、stay in touch。
不要拿市场信息开场（价格、减产传闻、"we're hearing…"）；不要提供服务（帮他采购、介绍买家、分享 SMM 的数据或成本、带他看 SMM 怎么评估价格）；不要把 SMM 的价格说成合同参考价；不要编 Bruce 的经历、行程或理由。对方是记者的，可以说 "happy to chat if an analyst's view is useful"。
写成一段，不拆条；不用 Dear、Regards，不用表情，不用 bro、haha、tho 这种 WhatsApp 口头禅。
“下次跟进”里如果有现成的英文草稿，可以沿用它的角度，按上面的规则写得更自然；如果写着还在等对方通过好友邀请，就写通过后的第一条。4 个选项挑不同的研究方向或对方不同的视角来写。
`;
const LINKEDIN_PROFILE = "LinkedIn 上比微信、WhatsApp 正式一点，但要像一个人在说话，不像群发：句子完整，语气友好、克制。";
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

const obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({ options: { type: "array", items: obj({ label: { type: "string" }, text: { type: "string" } }) } });

// 问 Claude，回答按 schema 给 JSON
async function askClaude(prompt: string, schema: Record<string, unknown>) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Supabase 里还没设置 ANTHROPIC_API_KEY");
  const r = await new Anthropic({ apiKey }).beta.messages.create({
    model: Deno.env.get("CLAUDE_MODEL") || "claude-opus-5-5",
    max_tokens: 16000,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    // 万一被安全审核挡下，服务端自动换一个模型重答
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
  if (r.stop_reason === "refusal") throw new Error("Claude 这次没答，再试一次");
  if (r.stop_reason === "max_tokens") throw new Error("回答太长被截断了，再试一次");
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
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
  const li = platform === "LinkedIn"; // LinkedIn 一律英文，不套微信、WhatsApp 的说话习惯和例句
  const en = li || (stats.lang ? stats.lang !== "zh" : samples.filter((t) => latin(t) > 0.6).length > samples.length / 2);
  const ex = li ? [] : (examples.data ?? []).filter((e) => (latin(e.text) > 0.6) === en);
  const learned = ex.filter((e) => !/导入$/.test(e.source)).slice(0, 8);
  const imported = shuffle(ex.filter((e) => /导入$/.test(e.source))).slice(0, 10);
  const lines = (rows: Record<string, unknown>[] | null, f: (r: any) => string) => (rows && rows.length ? rows.map(f).join("\n") : "（暂无）");
  let profile = li ? LINKEDIN_PROFILE : settings.data?.style_profile || DEFAULT_PROFILE;
  if (en && !li && !/英文|WhatsApp/.test(profile)) profile += "\n" + DEFAULT_PROFILE_EN;

  const prompt = `你在替 Bruce（周宗信）写一条要发给客户的${platform}消息。Bruce 是上海有色网（SMM）马来西亚办公室的镍、高镍生铁（NPI）、不锈钢分析师，二十多岁，马来西亚华人。他的目标是从客户那里拿到一手市场信息，并且和客户成为朋友。

【语言】
${li ? "用英文写，对方是华人也一样，也不要提可以改用中文聊。不要用微信表情代码（比如 [捂脸]）。下面的资料是中文，用到时翻成自然的英文。"
  : en ? "用英文写，照 Bruce 平时跟这位客户的英文口吻（看下面他说过的话和例句）。对方是印尼人可以称 Pak/Bu，偶尔夹一两个印尼语词也行。不要写中文，也不要用微信表情代码（比如 [捂脸]）。下面的资料和情报是中文，用到时翻成自然的英文。" : "用中文写。"}

${li ? LINKEDIN : ""}
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

【Bruce 手上最新的市场情报】（${li ? "LinkedIn 上只有对方已经回过话、聊开了才能用；" : ""}可以拿来亮牌，只说内容，绝不提来源或成交方的名字）
${lines(market.data, (i) => `- ${i.date} [${i.category}] ${i.content}`)}

今天是 ${today()}。
写 4 个不同角度的选项。每个选项是 Bruce 可以直接复制发出的${platform}消息：${li ? "一段英文，三四句话" : "口语，像他本人；最多 3 短句，可以拆成两条消息（用换行分开）"}；不要编号、引号、解释；不要说出任何成交方、买卖方或信息来源的名字；不提公司内部资料。
只回复 JSON：{"options":[{"label":"4到8个字说明这个角度","text":"消息内容"}]}`;

  try {
    const out = parseJson(await askClaude(prompt, SCHEMA));
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
