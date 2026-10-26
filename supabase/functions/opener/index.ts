// Supabase Edge Function「opener」：用 OpenAI 写客户开场白。
// OpenAI key 只存在 Supabase 的 Edge Function Secrets 里，网页拿不到。
// 需要的 Secrets：
//   OPENAI_API_KEY  你的 OpenAI API key
//   OPENAI_MODEL    要用的模型名，比如你在 OpenAI 后台能用的那个
// 部署时保持「Verify JWT」打开，只有登录的人才能调用。

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);

  const key = Deno.env.get("OPENAI_API_KEY");
  const model = Deno.env.get("OPENAI_MODEL");
  if (!key) return json({ error: "Supabase 里还没设置 OPENAI_API_KEY" }, 500);
  if (!model) return json({ error: "Supabase 里还没设置 OPENAI_MODEL" }, 500);

  let prompt = "";
  try {
    ({ prompt } = await req.json());
  } catch {
    return json({ error: "请求格式不对" }, 400);
  }
  if (typeof prompt !== "string" || !prompt.trim()) return json({ error: "缺少 prompt" }, 400);
  if (prompt.length > 20000) return json({ error: "资料太长了，删减一些再试" }, 413);

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.error?.message ?? `OpenAI 返回 ${r.status}`;
    return json({ error: msg }, 502);
  }
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) return json({ error: "OpenAI 没有返回内容" }, 502);
  return json({ text });
});
