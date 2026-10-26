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

### 3. 部署开场白函数
1. 打开 **Edge Functions → Deploy a new function → Via Editor**，函数名填 `opener`。
2. 把 `supabase/functions/opener/index.ts` 的内容粘进去，点 Deploy。保持 **Verify JWT** 打开。
3. 在 **Edge Functions → Secrets** 里加两个值：
   - `OPENAI_API_KEY`：你的 OpenAI API key
   - `OPENAI_MODEL`：你想用的模型名，以 OpenAI 后台列出的为准

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
- **跟进**：按分级的联系节奏（默认 A 级 3 天、B 级 7 天、C 级 30 天）列出该联系的人。节奏可以直接在页面上改。
- **快速记录**：聊完记一笔。写在「拿到的情报」里的内容会自动进情报库，同时更新这位客户的“上次聊过”。
- **✓ 今天聊过**：不写细节，只打个卡。
- **写开场白**：把客户资料、最近记录和最新情报发给 OpenAI，按你的说话风格写两个版本。注意：这一步会把这些内容发给 OpenAI。
- **设置 → 导出备份**：定期导出一份 JSON 存在电脑上，以后能用「导入数据」恢复。

## 更新客户数据
重新导出微信聊天后，让 Claude 重新分析并生成新的 `crm-seed.json`，再到「设置 → 导入数据」导入。同一位客户会更新资料，你写的记录和情报不会丢。
