// Supabase Edge Function「transcribe」：把一段通话录音转成文字（OpenAI 语音转写）。
// 只返回文字：音频不保存，也不写数据库。网页会把长录音切成 5 分钟一段，一段一段发过来。
// 需要的 Secrets：OPENAI_API_KEY；可选 OPENAI_TRANSCRIBE_MODEL（不填用 gpt-4o-transcribe，不可用时退回 whisper-1）
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_BYTES = 24 * 1024 * 1024; // OpenAI 单个文件上限 25MB
// 提示词让转写更认得行业词，也让中文统一出简体
const VOCAB = "SMM 上海有色网分析师 Bruce 和客户的电话，聊镍和不锈钢。常见词：SMM、镍铁、NPI、高镍生铁、镍点、高冰镍、MHP、硫酸镍、电解镍、LME、沪镍、304、316L、201、冷轧、热轧、黑卷、毛基、净基、到厂、舱底、FOB、CIF、升贴水、排产、减产、青山、德龙、永青、华新、印尼、雅加达、苏拉威西、莫罗瓦利、马来西亚、RKAB、红土镍矿、废不锈钢、铬铁。";
// 静音段常被转成这些字幕腔的句子，去掉
const JUNK = /(字幕|subtitles?).{0,6}(由|by)|Amara\.org|明镜与点点|点赞.{0,4}订阅|请不吝/i;

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

  const call = async (model: string, chunk: boolean) => {
    const fd = new FormData();
    fd.append("file", file, file.name || "audio.webm");
    fd.append("model", model);
    fd.append("response_format", "json");
    fd.append("prompt", prompt);
    if (chunk) fd.append("chunking_strategy", "auto");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd,
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, text: String(data?.text ?? ""), error: String(data?.error?.message ?? `OpenAI 返回 ${r.status}`) };
  };

  let model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "gpt-4o-transcribe";
  let chunk = model.startsWith("gpt-");
  let out = await call(model, chunk);
  if (!out.ok && chunk && /chunking/i.test(out.error)) { chunk = false; out = await call(model, false); }
  if (!out.ok && model !== "whisper-1" && (out.status === 404 || /model/i.test(out.error))) { model = "whisper-1"; out = await call(model, false); }
  if (!out.ok) return json({ error: out.error }, 502);

  const text = out.text.split(/\n+/).filter((l) => !JUNK.test(l)).join("\n").trim();
  return json({ text, model });
});
