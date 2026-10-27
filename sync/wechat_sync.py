#!/usr/bin/env python3
"""把本机微信里客户的新消息同步进镍圈客户簿。只在手动运行时同步，不常驻。

用法：
  python3 sync/wechat_sync.py login      第一次用：在终端里输入客户簿的邮箱和密码（只保存登录令牌，不保存密码）
  python3 sync/wechat_sync.py            刷新：增量解密微信 → 读客户的新消息 → 更新客户簿
  python3 sync/wechat_sync.py --dry-run  只看会更新什么，不写入
  python3 sync/wechat_sync.py --no-ai    不用 AI 从新消息里提取情报

只处理客户簿里已有的客户，以及备注以 “SMM” 开头的新联系人；私人聊天和群聊一律跳过。
依赖 yichen-wechat-local-vault（~/.claude/skills/yichen-wechat-local-vault）已经抓好密钥。
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
VAULT_SCRIPTS = Path.home() / ".claude/skills/yichen-wechat-local-vault/scripts"
STATE_DIR = Path.home() / ".config/nickel-crm"
SESSION_FILE = STATE_DIR / "session.json"
STATE_FILE = STATE_DIR / "wechat_sync_state.json"
KNOWN_FILE = STATE_DIR / "known_wxids.json"  # 导出时就已存在的联系人（同事、私人），不自动建卡
FIRST_SINCE = "2026-10-26 14:35:00"  # 微信导出（WeFlow）之后的消息才算新的
MY_SAMPLE_KEEP = 30
TEMPLATE = re.compile(r"早报|晨会|周报|日报|纪要|月报|群发|http|上海有色网.{0,6}(分析师|马来西亚)")
INTEL_HINT = re.compile(r"\d{3,}|报价|成交|价格|升水|贴水|基价|镍点|排产|减产|库存|出货|招标|配额|RKAB|FOB|CIF|LME|期货", re.I)


# ---------- small helpers ----------
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_private(path: Path, data) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def crm_id(username: str) -> str:
    return "c-" + re.sub(r"[^A-Za-z0-9_\-]", "_", username)[:120]


def day(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def read_config() -> tuple[str, str]:
    text = (HERE.parent / "config.js").read_text()
    url = re.search(r'supabaseUrl:\s*"([^"]+)"', text)
    key = re.search(r'supabaseAnonKey:\s*"([^"]+)"', text)
    if not url or not key:
        sys.exit("config.js 里没有 Supabase 地址或公开 key。")
    return url.group(1).rstrip("/"), key.group(1)


# ---------- Supabase over HTTPS ----------
def tls_context() -> ssl.SSLContext:
    # python.org 版的 Python 不自带根证书；用 macOS 系统证书包，其次 certifi
    for cafile in ("/etc/ssl/cert.pem",):
        if Path(cafile).exists():
            return ssl.create_default_context(cafile=cafile)
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


TLS = tls_context()


class Supabase:
    def __init__(self, url: str, anon: str):
        self.url, self.anon, self.token = url, anon, None

    def _call(self, method: str, path: str, body=None, headers=None, auth=True):
        h = {"apikey": self.anon, "Content-Type": "application/json"}
        if auth and self.token:
            h["Authorization"] = "Bearer " + self.token
        h.update(headers or {})
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=90, context=TLS) as r:
                raw = r.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if "invalid_grant" in detail or "Invalid login" in detail:
                raise SystemExit("邮箱或密码不对，或者登录已失效。重新运行：python3 sync/wechat_sync.py login") from None
            raise SystemExit(f"Supabase 返回 {e.code}：{detail}") from None
        except urllib.error.URLError as e:
            raise SystemExit(f"连不上 Supabase：{e.reason}") from None

    def login(self, email: str, password: str) -> dict:
        return self._call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password}, auth=False)

    def refresh(self, refresh_token: str) -> dict:
        return self._call("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": refresh_token}, auth=False)

    def select(self, table: str, query: str):
        return self._call("GET", f"/rest/v1/{table}?{query}")

    def insert(self, table: str, rows):
        return self._call("POST", f"/rest/v1/{table}", rows, {"Prefer": "return=minimal"})

    def update(self, table: str, match: str, patch: dict):
        return self._call("PATCH", f"/rest/v1/{table}?{match}", patch, {"Prefer": "return=minimal"})

    def delete(self, table: str, match: str):
        return self._call("DELETE", f"/rest/v1/{table}?{match}", None, {"Prefer": "return=minimal"})

    def fn(self, name: str, body: dict):
        return self._call("POST", f"/functions/v1/{name}", body)


def signed_in() -> Supabase:
    sb = Supabase(*read_config())
    session = load_json(SESSION_FILE, {})
    if not session.get("refresh_token"):
        sys.exit("还没登录。先运行：python3 sync/wechat_sync.py login")
    fresh = sb.refresh(session["refresh_token"])
    save_private(SESSION_FILE, {"refresh_token": fresh["refresh_token"], "email": fresh.get("user", {}).get("email", session.get("email", ""))})
    sb.token = fresh["access_token"]
    return sb


def cmd_login() -> None:
    sb = Supabase(*read_config())
    email = input("客户簿登录邮箱：").strip()
    password = getpass.getpass("密码（不会显示，也不会保存）：")
    s = sb.login(email, password)
    save_private(SESSION_FILE, {"refresh_token": s["refresh_token"], "email": email})
    print(f"登录好了：{email}。以后刷新不用再输入密码。")


# ---------- WeChat vault ----------
def load_vault():
    if not VAULT_SCRIPTS.exists():
        sys.exit(f"找不到 yichen-wechat-local-vault：{VAULT_SCRIPTS}")
    sys.path.insert(0, str(VAULT_SCRIPTS))
    import vault_cli  # noqa: E402  (the installed skill)
    return vault_cli


def decrypt_incremental() -> None:
    r = subprocess.run([sys.executable, str(VAULT_SCRIPTS / "decrypt_all_dbs.py"), "--mode", "incremental"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        tail = (r.stderr or r.stdout).strip().splitlines()[-3:]
        sys.exit("增量解密失败（微信更新或重新登录后密钥可能变了，需要重新抓密钥）：\n" + "\n".join(tail))


# ---------- sync ----------
def new_messages(vault, dec, s: dict, since: int):
    """这个会话 since 之后的消息，分成你发的和他发的（按发送人账号，vault 标的“我”不可靠）。"""
    chat = {"username": s["username"], "display_name": s["chat"], "is_group": False}
    msgs = [m for m in vault.collect_history(dec, chat, since + 1, None, 500, 0, None) if m["timestamp"] > since]
    msgs = [m for m in msgs if m["local_type"] is not None and vault.split_msg_type(m["local_type"])[0] not in (10000, 10002)]
    mine = [m for m in msgs if (m["sender_username"] and m["sender_username"] != s["username"])
            or (not m["sender_username"] and m["sender"] == "我")]
    theirs = [m for m in msgs if m not in mine]
    return msgs, mine, theirs


def extract_intel(sb: Supabase, vault, cid: str, c: dict, msgs, mine, theirs) -> list[dict]:
    """把这段对话交给 extract 函数，挑出客户说的情报。"""
    is_text = lambda m: vault.split_msg_type(m["local_type"])[0] == 1
    if not any(is_text(m) and INTEL_HINT.search(m["content"] or "") for m in theirs):
        return []
    convo = [{"time": m["time"], "me": m in mine, "text": (m["content"] or "")[:400]} for m in msgs[-60:] if is_text(m)]
    out = sb.fn("extract", {"contactName": c["name"], "contactCompany": c.get("company") or "", "messages": convo}) or {}
    fallback = day(msgs[-1]["timestamp"])
    return [{"contact_id": cid, "contact_name": c["name"], "date": it.get("date") or fallback,
             "category": it.get("category") or "其他", "content": it["content"], "source": "微信自动"}
            for it in (out.get("items") or [])[:8]]


def redo_intel(sb: Supabase, vault, dec, sessions, crm: dict, since: int, dry: bool) -> None:
    """用现在的提取规则，把 since 之后自动提取的情报重做一遍（只动“微信自动”的情报，不碰客户卡和记录）。"""
    total, names = 0, []
    for s in sessions:
        cid = crm_id(s["username"])
        if cid not in crm or s["timestamp"] <= since:
            continue
        msgs, mine, theirs = new_messages(vault, dec, s, since)
        if not msgs:
            continue
        rows = [] if dry else extract_intel(sb, vault, cid, crm[cid], msgs, mine, theirs)
        if not dry:
            sb.delete("intel", f"contact_id=eq.{urllib.parse.quote(cid)}&source=eq.{urllib.parse.quote('微信自动')}&date=gte.{day(since)}")
            if rows:
                sb.insert("intel", rows)
        total += len(rows)
        names.append(f"{crm[cid]['name']}：{len(rows)} 条" + "".join(f"\n      · [{r['category']}] {r['content']}" for r in rows))
    print(f"重做完成{'（试运行）' if dry else ''}：{len(names)} 位客户，新情报 {total} 条。")
    for n in names:
        print("  - " + n)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", choices=["login"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--since", help="只同步这个时间之后的消息，比如 2026-10-26 14:35:00（覆盖记录的进度）")
    ap.add_argument("--redo-intel", action="store_true", help="用现在的规则重做 --since（默认导出之后）以来自动提取的情报")
    args = ap.parse_args()
    if args.cmd == "login":
        return cmd_login()

    sb = signed_in()
    vault = load_vault()
    print("· 增量解密微信…", flush=True)
    decrypt_incremental()
    dec = vault.resolve_decrypted_dir(None)
    wx_contacts, _ = vault.load_contacts(dec)
    sessions = [s for s in vault.session_rows(dec, False, None) if not s["is_group"] and not s["username"].startswith("gh_")]

    crm = {c["id"]: c for c in sb.select("contacts", "select=id,name,company,tier,last_their,last_touch,my_samples&limit=2000")}
    state = load_json(STATE_FILE, {})
    since_all = state.get("since", {})
    default_since = int(datetime.strptime(args.since or FIRST_SINCE, "%Y-%m-%d %H:%M:%S").timestamp())
    if args.redo_intel:
        return redo_intel(sb, vault, dec, sessions, crm, default_since, args.dry_run)

    # 备注以 SMM 开头、导出之后才加的新联系人：建成 C 级新客户（导出时就在的同事、私人联系人不建）
    known = set(load_json(KNOWN_FILE, []))
    new_people = []
    for s in sessions:
        w = wx_contacts.get(s["username"], {})
        remark = re.sub(r"\s+", " ", (w.get("remark") or "")).strip()
        if crm_id(s["username"]) not in crm and s["username"] not in known and re.match(r"^SMM", remark, re.I):
            name = re.sub(r"[\s\-~～]*(\+?\d[\d\s]{7,}\d)", "", re.sub(r"^SMM\s*", "", remark, flags=re.I)).strip() or remark
            row = {"id": crm_id(s["username"]), "name": name, "wechat_name": remark, "tier": "C", "relation": "未激活",
                   "segment": "其他/未知", "source": "微信同步", "my_samples": []}
            new_people.append(row)
            crm[row["id"]] = {**row, "last_their": None, "last_touch": None}
    if new_people and not args.dry_run:
        sb.insert("contacts", new_people)

    summary = {"clients": 0, "their": 0, "mine": 0, "logs": 0, "intel": 0, "new": len(new_people), "names": []}
    for s in sessions:
        cid = crm_id(s["username"])
        if cid not in crm:
            continue  # 私人聊天，不碰
        since = int(args.since and default_since or since_all.get(s["username"], default_since))
        if s["timestamp"] <= since:
            continue
        msgs, mine, theirs = new_messages(vault, dec, s, since)
        if not msgs:
            since_all[s["username"]] = s["timestamp"]
            continue
        c = crm[cid]
        last_any = day(msgs[-1]["timestamp"])
        patch = {"updated_at": datetime.now().astimezone().isoformat()}
        if theirs:
            lt = day(theirs[-1]["timestamp"])
            if not c.get("last_their") or lt > c["last_their"]:
                patch["last_their"] = lt
        if not c.get("last_touch") or last_any > str(c["last_touch"])[:10]:
            patch["last_touch"] = last_any
        texts = [m["content"].strip() for m in mine if vault.split_msg_type(m["local_type"])[0] == 1]
        texts = [t for t in texts if 3 <= len(t) <= 70 and not TEMPLATE.search(t)]
        if texts:
            patch["my_samples"] = ((c.get("my_samples") or []) + texts)[-MY_SAMPLE_KEEP:]
        last_their_text = next((m["content"] for m in reversed(theirs) if vault.split_msg_type(m["local_type"])[0] == 1), "")
        note = f"微信同步：他发 {len(theirs)} 条，我发 {len(mine)} 条。" + (f"他最后说：{last_their_text[:60]}" if last_their_text else "")
        log = {"contact_id": cid, "contact_name": c["name"], "channel": "微信", "date": last_any, "summary": note, "next": ""}

        intel_rows = [] if args.no_ai or args.dry_run else extract_intel(sb, vault, cid, c, msgs, mine, theirs)

        if not args.dry_run:
            sb.update("contacts", "id=eq." + urllib.parse.quote(cid), patch)
            sb.insert("logs", [log])
            if intel_rows:
                sb.insert("intel", intel_rows)
            since_all[s["username"]] = msgs[-1]["timestamp"]
        summary["clients"] += 1; summary["their"] += len(theirs); summary["mine"] += len(mine)
        summary["logs"] += 1; summary["intel"] += len(intel_rows)
        summary["names"].append(f"{c['name']}（他 {len(theirs)} / 我 {len(mine)}" + (f"，情报 {len(intel_rows)}" if intel_rows else "") + "）")

    if not args.dry_run:
        save_private(STATE_FILE, {"since": since_all, "last_run": datetime.now().isoformat(timespec="seconds")})
    head = "（试运行，没有写入）" if args.dry_run else ""
    print(f"完成{head}：{summary['clients']} 位客户有新消息（他发 {summary['their']} 条，我发 {summary['mine']} 条），"
          f"记了 {summary['logs']} 笔，提取情报 {summary['intel']} 条，新建客户 {summary['new']} 位。")
    for n in summary["names"]:
        print("  - " + n)
    for p in new_people:
        print(f"  + 新客户：{p['name']}")


if __name__ == "__main__":
    main()
