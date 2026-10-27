# 镍圈客户簿

Bruce 的个人客户管理工具：跟进提醒、快速记录、情报日志、一键写开场白（OpenAI）。

- 网页放在 GitHub Pages（公开的静态页面，只有代码）
- 数据放在你自己的 Supabase 数据库，必须登录才能读写，每个人只能看到自己的数据
- OpenAI key 只存在 Supabase 的 Edge Function Secrets 里，网页和仓库里都没有

**永远不要提交到仓库的东西**：`crm-seed.json`、导出的备份、聊天记录、`service_role` key、OpenAI key。`.gitignore` 已经挡住了常见的文件名。

## 一次性设置（约 15 分钟）

### 1. 建 Supabase 项目
1. 在 supabase.com 注册并新建项目。Region 选 Singapore，离马来西亚近。
2. 进 **Project Settings → API**，记下 **Project URL** 和 **anon / publishable key**。

### 2. 建表
打开 **SQL Editor**，把 `supabase/schema.sql` 整段粘进去，点 **Run**。

然后再依次运行 `supabase/migration-002-style.sql`（说话风格样本用的表）和 `supabase/migration-003-call.sql`（记录里存通话原文）。

### 3. 部署两个函数
1. 打开 **Edge Functions → Deploy a new function → Via Editor**，函数名填 `opener`，把 `supabase/functions/opener/index.ts` 的内容粘进去，点 Deploy。
2. 同样再建 `agent`、`transcribe`、`callnote`，分别粘 `supabase/functions/` 下同名文件夹里的 `index.ts`（`transcribe` 用到 npm 上的 `opencc-js` 把繁体转简体，部署时自动下载）。
3. 每个函数都在代码里自己检查登录，保持 **Verify JWT** 打开也没问题。
3. 在 **Edge Functions → Secrets** 里加两个值：
   - `OPENAI_API_KEY`：你的 OpenAI API key
   - `OPENAI_MODEL`：你想用的模型名，以 OpenAI 后台列出的为准
   - 可选 `OPENAI_TRANSCRIBE_MODEL`：通话转文字的模型，不填用 `gpt-transcribe`
   - 可选 `OPENAI_DIARIZE_MODEL`：分说话人的模型，不填用 `gpt-4o-transcribe-diarize`（OpenAI 唯一能分说话人的模型，2027-02-26 下线；填 `off` 关掉）

### 4. 设置登录
1. **Authentication → URL Configuration → Redirect URLs** 里加上 `https://<你的用户名>.github.io/nickel-crm/**`。如果这个 Supabase 项目只给 CRM 用，也可以直接把 Site URL 改成这个网址；如果还有别的应用在用，就别动 Site URL。
2. 先别关注册，第 6 步注册完再关。如果同一个项目里还有别的应用要注册新用户，就保留注册：每张表都有行级权限，别人注册了也看不到你的数据。

### 5. 填配置
把 Project URL 和 anon key 填进 `config.js`，提交并推送。这两个值本来就是给网页用的，可以公开。

### 6. 第一次登录和导入
1. 打开网站，点「第一次用？注册账号」，用你的邮箱注册，去邮箱点确认链接。
2. 登录后点右上角「设置 → 导入数据」，选 `Documents/SMM/CRM/crm-seed.json`（175 位客户、164 条情报）。
3. 回到 Supabase，在 **Authentication → Sign In / Providers** 里关掉 **Allow new users to sign up**，这样别人没法注册。

## 日常用法
- **今天**：按分级的联系节奏（默认 A 级 3 天、B 级 7 天、C 级 30 天）列出该联系的人，每张卡片会建议一种开口方式。节奏在「设置」里改。
- **写开场白**：选这次想做什么（询价、日常闲聊、分享观点、约见面、回访跟进），可以补一句想聊的，生成 4 个不同角度的选项。会参考你的说话习惯、你以前跟这位客户说过的话、你在这个场景的真实例句。
- **发了，记一笔**：选中一个选项（可以先「改一改」），点这个按钮会记下这次联系，并把你最终发出的那句话存成说话样本，以后写得越来越像你。
- **记一笔**：聊完记一笔。写在「拿到的情报」里的内容会进情报库，同时更新这位客户的“上次聊过”。
- **通话转录**：侧边栏、客户详情、「记一笔」里都有入口。三种来源：现在录音（手机开免提放在电脑旁边，或者打完马上口述要点）、上传录音（手机通话录音、语音备忘录，多长都行）、粘贴已有的文字稿。转完 AI 整理出要点（个人近况单独一条）、情报和下次跟进，你改完勾选再保存：记一笔“电话”，勾上的情报进情报库，原文存在这条记录里，在客户详情的往来里能展开看。音频只用来转文字，不保存。币种和口径对不上、两份转写数字不一致的情报会标“（待核对）”。录通话前先跟对方打声招呼。
  - 转的时候可以关掉抽屉做别的：左边栏（手机在顶栏）显示进度，转好了变成「通话待确认」，网页标题也会提示，点一下回来确认。审阅时点「先放着」可以晚点再存，「不要了」丢掉。一次只转一通。转录在浏览器里跑，网页要开着；手机切走或锁屏会暂停，关网页或刷新会先问一下。
  - 怎么分出谁说的：录音切成 2 分钟一段，每段同时送两个模型，`gpt-transcribe` 出准确的字，`gpt-4o-transcribe-diarize` 分说话人；第一段转完从里面截出每个人几秒钟的声音，后面各段带上，标签才对得上；最后由 `callnote` 认出哪位是 Bruce、哪位是客户，原文里换成名字。存下来的原文有两份：分说话人的（字可能不准）和不分说话人的（字更准）。
  - 分说话人的模型 2027-02-26 下线后照样能用，只是原文不再分说话人，整理时按内容判断哪些话是客户说的。
- **参谋**：直接问“今天先找谁”“NPI 询价找谁最准”“谁能给我废钢价格”。它会读你全部的客户、最近 40 条记录和情报再回答，推荐的人可以直接点开写开场白。
- **设置 → 我的说话习惯**：开场白照这段写，可以直接改。
- **设置 → 导出备份**：定期导出一份 JSON 存在电脑上，以后能用「导入数据」恢复。

写开场白、问参谋和通话转录时，客户资料、记录、情报和通话录音会发给 OpenAI。

## 刷新：微信和 WhatsApp 同步（手动）

前提：本机已经用 yichen-wechat-local-vault 抓好微信密钥（`~/.config/wechat-keys.json`），Mac 上的微信保持登录；WhatsApp Desktop 装着并登录。

```bash
python3 sync/wechat_sync.py login      # 第一次：输入客户簿邮箱和密码，只保存登录令牌
python3 sync/wechat_sync.py            # 刷新（微信和 WhatsApp 一起）
python3 sync/wechat_sync.py --dry-run  # 只看会更新什么
python3 sync/wechat_sync.py --no-ai    # 不用 AI 提取情报
python3 sync/wechat_sync.py --no-wechat    # 只刷新 WhatsApp（--no-whatsapp 只刷新微信）
```

微信：增量解密微信 → 只读客户簿里已有客户的新消息（私人聊天、群聊都跳过）→ 更新“上次聊过”、记一笔“微信同步”、把你新发的话加进说话样本 → 用 `extract` 函数从客户发来的消息里提取价格和成交（标“微信自动”）→ 备注以 SMM 开头的新联系人自动建成 C 级客户。

WhatsApp：把 WhatsApp Desktop 的本机数据库复制到临时目录再读（读完删掉，不碰原文件）→ 只读客户簿里 WhatsApp 客户和客户群的新消息和通话 → 更新“上次聊过”和来往条数、记一笔“WhatsApp同步”、加说话样本 → 提取情报（标“WhatsApp自动”）。客户卡的 `stats.wa.jid` 记着对应的会话；没记的按 `w-` 开头的 id 或电话号码对上。不在客户簿里的新会话不同步、不建卡，只在终端列出名字。

微信或 WhatsApp 有一边出错，另一边照样刷新。同步进度和登录令牌存在 `~/.config/nickel-crm/`，不进仓库。

需要在 Supabase 里多部署一个 `extract` 函数（`supabase/functions/extract/index.ts`）。

## WhatsApp 客户

2026-10-27 从 WhatsApp Desktop 导出的对话（144 个会话）里挑出 108 个业务会话导入：106 位新客户（含十几个客户群，名字后面带“（群）”），李理和 Teoh 两位和微信里已有的人合并。同事、自己的号码、私人服务、内部群没有导入。

- 客户 id 以 `w-` 开头（群是 `w-g-`），`stats.platform = "WhatsApp"`，`stats.lang` 记 Bruce 跟他用什么语言（en / zh / id），`stats.wa` 是 WhatsApp 的来往条数和通话次数。
- 情报来源标“WhatsApp导入”，说话样本来源也是“WhatsApp导入”。之后刷新进来的情报标“WhatsApp自动”。
- 写开场白时，英文客户（lang 不是 zh）会用英文写，照「设置 → 我的说话习惯」里的英文部分和他的英文例句；记一笔、聊过了默认记成 WhatsApp。
- 「客户」页可以按渠道筛选（微信 / WhatsApp）。

## 更新客户数据
重新导出微信聊天后，让 Claude 重新分析并生成新的 `crm-seed.json`，再到「设置 → 导入数据」导入。同一位客户会更新资料，你写的记录和情报不会丢。
