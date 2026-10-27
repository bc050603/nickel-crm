// Supabase Edge Function「transcribe」：把一段通话录音转成文字，并分出说话人（OpenAI 语音转写）。
// 同一段音频同时送两个模型：gpt-transcribe 出准确的字（收行业关键词），gpt-4o-transcribe-diarize 分出谁说的。
// 网页把长录音切成 2 分钟一段发过来；从第二段起附上第一段里每个人的声音样本，让各段的说话人标签对得上。
// 只返回文字：音频不保存，也不写数据库。
// 需要的 Secrets：OPENAI_API_KEY。可选：OPENAI_TRANSCRIBE_MODEL（出字的模型，默认 gpt-transcribe）、
// OPENAI_DIARIZE_MODEL（分说话人的模型，默认 gpt-4o-transcribe-diarize，2027-02-26 下线；填 off 关掉）。
// 分说话人的模型下线后照样能转，只是不分说话人，由 callnote 按内容判断谁说的。
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import * as OpenCC from "npm:opencc-js@1.4.2/t2cn";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 24 * 1024 * 1024; // OpenAI 单个文件上限 25MB
const VOCAB = "SMM 上海有色网分析师 Bruce 和客户的电话，聊镍和不锈钢，用简体中文。";
// 关键词提示（每个一行，不能带尖括号和换行）
const KEYWORDS = ["SMM", "上海有色网", "镍铁", "NPI", "高镍生铁", "镍点", "高冰镍", "MHP", "硫酸镍", "LME", "沪镍", "304", "316L", "冷轧", "热轧", "毛基", "到厂", "舱底", "FOB", "CIF", "升贴水", "排产", "减产", "青山", "德龙", "永青", "华新", "印尼", "雅加达", "苏拉威西", "RKAB", "红土镍矿", "废不锈钢", "铬铁"];
// 静音段常被转成这些字幕腔的句子，去掉
const JUNK = /(字幕|subtitles?).{0,6}(由|by)|Amara\.org|明镜与点点|点赞.{0,4}订阅|请不吝/i;
const toCN = OpenCC.Converter({ from: "tw", to: "cn" }); // 分说话人的模型不收提示词，偶尔出繁体

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, req.headers.get("apikey") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: auth } = await sb.auth.getUser();
  if (!auth?.user) return json({ error: "请先登录" }, 401);

  let form: FormData;
  try { form = await req.formData(); } catch { return json({ error: "请求格式不对" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return json({ error: "没收到音频" }, 400);
  if (file.size > MAX_BYTES) return json({ error: "这段音频超过 24MB，分段后再传" }, 413);

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return json({ error: "Supabase 里还没设置 OPENAI_API_KEY" }, 500);

  const who = String(form.get("contact") ?? "").trim().slice(0, 60);
  const prev = String(form.get("prev") ?? "").trim().slice(-200); // 上一段的结尾，接得更顺
  const prompt = VOCAB + (who ? `对方是${who}。` : "") + prev;
  // 声音样本：[{name, url: "data:audio/wav;base64,..."}]，每个 2 到 10 秒，最多 4 个
  let refs: { name: string; url: string }[] = [];
  try {
    const a = JSON.parse(String(form.get("refs") ?? "[]"));
    if (Array.isArray(a)) refs = a.filter((r) => r && typeof r.name === "string" && /^data:audio\//.test(String(r.url))).slice(0, 4);
  } catch { /* 没有样本也能转 */ }

  const send = async (fields: [string, string][]) => {
    const fd = new FormData();
    fd.append("file", file, file.name || "audio.webm");
    for (const [k, v] of fields) fd.append(k, v);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data, error: String(data?.error?.message ?? `OpenAI 返回 ${r.status}`) };
  };
  const gone = (o: { status: number; error: string }) => o.status === 404 || /model|deprecat|shut ?down|not (found|available|supported)/i.test(o.error);

  // 出字：按顺序试，模型下线就换下一个
  const textPass = async (): Promise<{ model?: string; text?: string; error?: string }> => {
    for (const model of [...new Set([Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-transcribe", "gpt-4o-transcribe", "whisper-1"])]) {
      const hints: [string, string][] = [["prompt", model === "gpt-transcribe" ? prompt : prompt + "常见词：" + KEYWORDS.join("、") + "。"]];
      if (model === "gpt-transcribe") { for (const k of KEYWORDS) hints.push(["keywords[]", k]); hints.push(["languages[]", "zh"]); } // 加上 en 会把“一零三零”听成“E0.30”
      let o = await send([["model", model], ...hints]);
      if (!o.ok && /keyword|language|prompt/i.test(o.error)) o = await send([["model", model]]);
      if (o.ok) return { model, text: String(o.data?.text ?? "") };
      if (!gone(o)) return { error: o.error };
    }
    return { error: "没有可用的转写模型" };
  };
  // 分说话人：不收提示词；超过 30 秒要分块
  const speakerPass = async (): Promise<{ model?: string; text?: string; segments?: any[]; error?: string } | null> => {
    const model = Deno.env.get("OPENAI_DIARIZE_MODEL") ?? "gpt-4o-transcribe-diarize";
    if (!model || model === "off") return null;
    const base: [string, string][] = [["model", model], ["response_format", "diarized_json"], ["chunking_strategy", "auto"]];
    const named: [string, string][] = refs.flatMap((r) => [["known_speaker_names[]", r.name], ["known_speaker_references[]", r.url]] as [string, string][]);
    let o = await send([...base, ...named]);
    if (!o.ok && refs.length && /speaker|reference/i.test(o.error)) o = await send(base);
    if (!o.ok) return { error: o.error };
    return { model, text: String(o.data?.text ?? ""), segments: Array.isArray(o.data?.segments) ? o.data.segments : [] };
  };

  const [t, s] = await Promise.all([textPass(), speakerPass()]);
  if (t.error && (!s || s.error)) return json({ error: t.error }, 502);

  const clean = (x: string) => toCN(x).split(/\n+/).filter((l) => !JUNK.test(l)).join("\n").trim();
  const segments = (s && !s.error ? s.segments! : [])
    .map((g: any) => ({ speaker: String(g?.speaker ?? ""), text: clean(String(g?.text ?? "")), start: Number(g?.start) || 0, end: Number(g?.end) || 0 }))
    .filter((g) => g.text);
  return json({ text: clean(t.text ?? s?.text ?? ""), segments, model: [t.model, s && !s.error ? s.model : ""].filter(Boolean).join(" + ") });
});
