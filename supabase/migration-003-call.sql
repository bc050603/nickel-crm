-- 第三次升级：通话转录。记录里多存一份通话原文（音频本身不存）。
-- 在 Supabase 的 SQL Editor 里整段运行一次即可，重复运行也没关系。
alter table public.logs add column if not exists transcript text;
