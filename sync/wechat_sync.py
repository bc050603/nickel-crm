#!/usr/bin/env python3
"""把本机微信和 WhatsApp 里客户的新消息同步进镍圈客户簿。只在手动运行时同步，不常驻。

用法：
  python3 sync/wechat_sync.py login      第一次用：在终端里输入客户簿的邮箱和密码（只保存登录令牌，不保存密码）
  python3 sync/wechat_sync.py            刷新：微信和 WhatsApp 一起，读客户的新消息 → 更新客户簿
  python3 sync/wechat_sync.py --dry-run  只看会更新什么，不写入
  python3 sync/wechat_sync.py --no-ai    不用 AI 从新消息里提取情报
  python3 sync/wechat_sync.py --no-wechat / --no-whatsapp   只刷新其中一边

微信：只处理客户簿里已有的客户，以及备注以 “SMM” 开头的新联系人；私人聊天和群聊一律跳过。
依赖 yichen-wechat-local-vault（~/.claude/skills/yichen-wechat-local-vault）已经抓好密钥。
WhatsApp：读 WhatsApp Desktop 的本机数据库（先复制到临时目录再读，读完删掉），只处理客户簿里的 WhatsApp 客户和客户群；
不在客户簿里的新会话只列出名字，不建卡。
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import sqlite3
import ssl
import subprocess
import sys
import tempfile
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
TEMPLATE = re.compile(r"早报|晨会|周报|日报|纪要|月报|群发|http|上海有色网.{0,6}(分析师|马来西亚)"
                      r"|SMM Daily|Weekly Wrap|Morning Brief|SMM Analysis", re.I)
INTEL_HINT = re.compile(r"\d{3,}|报价|成交|价格|升水|贴水|基价|镍点|排产|减产|库存|出货|招标|配额|RKAB|FOB|CIF|LME|期货"
                        r"|price|offer|\bbid|deal|tender|quota|cargo|shipment|stock|inventory|output|discount|premium", re.I)

WA_DIR = Path.home() / "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
WA_KNOWN_FILE = STATE_DIR / "known_wa_jids.json"  # 导出时就有的 WhatsApp 会话（同事、私人），新会话提醒时不列
WA_FIRST_SINCE = "2026-10-27 11:31:00"  # WhatsApp 导出之后的消息才算新的
APPLE_EPOCH = 978307200  # WhatsApp 的时间从 2001-01-01 算起
WA_SYSTEM = {6, 10}  # 系统消息
WA_TEXT = {0, 7}  # 文字、带链接的文字


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


# ---------- WhatsApp ----------
def wa_snapshot(tmp: str) -> dict:
    """把 WhatsApp 的数据库连同 -wal/-shm 复制到临时目录再打开，不碰原文件。"""
    dbs = {}
    for name in ("ChatStorage", "ContactsV2", "LID", "CallHistory"):
        for ext in ("", "-wal", "-shm"):
            p = WA_DIR / f"{name}.sqlite{ext}"
            if p.exists():
                shutil.copy2(p, tmp)
        if (Path(tmp) / f"{name}.sqlite").exists():
            dbs[name] = sqlite3.connect(Path(tmp) / f"{name}.sqlite")
    if "ChatStorage" not in dbs:
        raise SystemExit("找不到 WhatsApp Desktop 的数据（Mac 上要装着 WhatsApp 并登录过）。")
    return dbs


def wa_names(dbs: dict):
    """群里发消息的人叫什么：通讯录名字 > 对方自己设的昵称 > 号码。"""
    names, push, lid_phone = {}, {}, {}
    if "ContactsV2" in dbs:
        for full, lid, wid in dbs["ContactsV2"].execute(
                "SELECT ZFULLNAME, ZLID, ZWHATSAPPID FROM ZWAADDRESSBOOKCONTACT WHERE ZFULLNAME IS NOT NULL"):
            for jid in (lid, wid):
                if jid:
                    names[jid] = full
    if "LID" in dbs:
        lid_phone = dict(dbs["LID"].execute(
            "SELECT ZIDENTIFIER, ZPHONENUMBER FROM ZWAZACCOUNT WHERE ZIDENTIFIER IS NOT NULL AND ZPHONENUMBER IS NOT NULL"))
    for jid, p in dbs["ChatStorage"].execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME"):
        if p and p.strip("~ "):
            push[jid] = p.strip("~ ")

    def resolve(jid):
        if not jid:
            return "群友"
        phone = lid_phone.get(jid)
        pjid = f"{phone}@s.whatsapp.net" if phone else jid
        return names.get(jid) or names.get(pjid) or push.get(jid) or push.get(pjid) or "+" + (phone or jid.split("@")[0])
    return resolve, lid_phone


def wa_calls(dbs: dict, since: float) -> list[tuple]:
    """since 之后的通话：(时间, 秒数, 群 jid, 是否呼入, 是否未接, 参与人 jid)。"""
    if "CallHistory" not in dbs:
        return []
    rows = dbs["CallHistory"].execute("""
        SELECT e.ZDATE, e.ZDURATION, e.ZGROUPJIDSTRING, a.ZINCOMING, a.ZMISSED,
               (SELECT group_concat(p.ZJIDSTRING) FROM ZWACDCALLEVENTPARTICIPANT p WHERE p.Z1PARTICIPANTS = e.Z_PK)
        FROM ZWACDCALLEVENT e LEFT JOIN ZWAAGGREGATECALLEVENT a ON a.Z_PK = e.Z1CALLEVENTS
        WHERE e.ZDATE > ?""", (since - APPLE_EPOCH,)).fetchall()
    return [((ts or 0) + APPLE_EPOCH, int(dur or 0), group, bool(inc), bool(missed), set(filter(None, (parts or "").split(","))))
            for ts, dur, group, inc, missed, parts in rows]


def wa_match(crm: dict, jid: str, lid_phone: dict):
    """这个会话是客户簿里的谁：先看记下的 jid，再看 w- 开头的 id，最后对电话号码。"""
    by_jid = {(c.get("stats") or {}).get("wa", {}).get("jid"): c for c in crm.values()}
    user = jid.split("@")[0]
    phone = lid_phone.get(jid) or (user if jid.endswith("@s.whatsapp.net") else "")
    alias = {jid, f"{phone}@s.whatsapp.net"} | {l for l, p in lid_phone.items() if phone and p == phone}
    for a in alias:
        if a in by_jid:
            return by_jid[a], alias
    if jid.endswith("@g.us"):
        return crm.get("w-g-" + re.sub(r"\D", "", user)), alias
    c = crm.get("w-" + phone) if phone else None
    if not c and phone and len(phone) >= 8:
        c = next((x for x in crm.values() if re.sub(r"\D", "", x.get("phone") or "") == phone), None)
    return c, alias


def sync_whatsapp(sb: Supabase, state: dict, args) -> dict:
    crm = {c["id"]: c for c in sb.select("contacts", "select=id,name,company,phone,stats,last_their,last_touch,my_samples&limit=2000")}
    since_all = state.setdefault("wa_since", {})
    default_since = datetime.strptime(args.since or WA_FIRST_SINCE, "%Y-%m-%d %H:%M:%S").timestamp()
    last_run = state.get("wa_last_run") or default_since
    summary = {"clients": 0, "their": 0, "mine": 0, "calls": 0, "logs": 0, "intel": 0, "names": [], "unknown": []}
    tmp = tempfile.mkdtemp(prefix="nickel-wa-")
    try:
        dbs = wa_snapshot(tmp)
        cs = dbs["ChatStorage"]
        resolve, lid_phone = wa_names(dbs)
        member = dict(cs.execute("SELECT Z_PK, ZMEMBERJID FROM ZWAGROUPMEMBER"))
        chats = cs.execute("SELECT Z_PK, ZSESSIONTYPE, ZPARTNERNAME, ZCONTACTJID, ZLASTMESSAGEDATE FROM ZWACHATSESSION "
                           "WHERE ZSESSIONTYPE IN (0, 1, 4) AND ZCONTACTJID IS NOT NULL").fetchall()
        if not WA_KNOWN_FILE.exists():
            save_private(WA_KNOWN_FILE, sorted(j for *_, j, _ in chats))
        known = set(load_json(WA_KNOWN_FILE, []))
        oldest = min([float(args.since and default_since or since_all.get(j, default_since)) for *_, j, _ in chats] or [default_since])
        calls = wa_calls(dbs, oldest)
        for pk, stype, partner, jid, last_date in chats:
            c, alias = wa_match(crm, jid, lid_phone)
            if not c:
                # 不在客户簿里：私人聊天和同事不碰；导出之后才有的新会话、刷新以来有动静的，只列名字
                if jid not in known and (last_date or 0) + APPLE_EPOCH > last_run:
                    summary["unknown"].append(re.sub(r"[‪-‮⁦-⁩‎‏]", "", partner or "").strip() or resolve(jid))
                continue
            group = stype != 0
            since = float(args.since and default_since or since_all.get(jid, default_since))
            if (last_date or 0) + APPLE_EPOCH <= since and not any(t > since for t, *_ in calls):
                continue
            rows = cs.execute("""
                SELECT m.ZMESSAGEDATE, m.ZISFROMME, m.ZMESSAGETYPE, m.ZTEXT, m.ZGROUPMEMBER, m.ZFROMJID
                FROM ZWAMESSAGE m WHERE m.ZCHATSESSION = ? AND m.ZMESSAGEDATE > ? ORDER BY m.ZMESSAGEDATE, m.Z_PK""",
                              (pk, since - APPLE_EPOCH)).fetchall()
            msgs = [{"ts": ts + APPLE_EPOCH, "me": bool(me), "type": t, "text": (text or "").strip(),
                     "who": "Bruce" if me else (resolve(member.get(gm)) if group else c["name"])}
                    for ts, me, t, text, gm, fj in rows if t not in WA_SYSTEM]
            mine = [m for m in msgs if m["me"]]
            theirs = [m for m in msgs if not m["me"]]
            mine_calls = [x for x in calls if x[0] > since and (x[2] == jid if group else bool(x[5] & alias))]
            talked = [x for x in mine_calls if x[1] > 0]
            if not msgs and not mine_calls:
                since_all[jid] = (last_date or 0) + APPLE_EPOCH
                continue

            stamps = [m["ts"] for m in msgs] + [x[0] for x in talked]
            their_stamps = [m["ts"] for m in theirs] + [x[0] for x in mine_calls if x[3]]
            last_any = day(int(max(stamps))) if stamps else None
            stats = dict(c.get("stats") or {})
            wa = dict(stats.get("wa") or {})
            wa.update(jid=jid, me=wa.get("me", 0) + len(mine), them=wa.get("them", 0) + len(theirs),
                      calls=wa.get("calls", 0) + len(talked))
            if last_any and last_any > str(wa.get("last") or ""):
                wa["last"] = last_any
            stats["wa"] = wa
            patch = {"stats": stats, "updated_at": datetime.now().astimezone().isoformat()}
            if their_stamps:
                lt = day(int(max(their_stamps)))
                if not c.get("last_their") or lt > c["last_their"]:
                    patch["last_their"] = lt
            if last_any and (not c.get("last_touch") or last_any > str(c["last_touch"])[:10]):
                patch["last_touch"] = last_any
            texts = [m["text"] for m in mine if m["type"] in WA_TEXT]
            texts = [t for t in texts if 3 <= len(t) <= (160 if re.search(r"[A-Za-z]{3}", t) and not re.search(r"[一-鿿]", t) else 70)
                     and not TEMPLATE.search(t)]
            if texts:
                patch["my_samples"] = ((c.get("my_samples") or []) + texts)[-MY_SAMPLE_KEEP:]

            last_their = next((m for m in reversed(theirs) if m["type"] in WA_TEXT and m["text"]), None)
            them_word = "群里" if group else "他"
            parts = [f"{them_word}发 {len(theirs)} 条", f"我发 {len(mine)} 条"]
            if talked:
                parts.append(f"通话 {len(talked)} 次（{sum(x[1] for x in talked) // 60} 分钟）")
            missed_in = [x for x in mine_calls if x[3] and x[1] == 0]
            if missed_in:
                parts.append(f"未接来电 {len(missed_in)} 个")
            note = ("WhatsApp群同步：" if group else "WhatsApp同步：") + "，".join(parts) + "。"
            if last_their:
                note += f"{last_their['who'] if group else '他'}最后说：{last_their['text'][:60]}"
            log_day = last_any or day(int(max(x[0] for x in mine_calls)))
            log = {"contact_id": c["id"], "contact_name": c["name"], "channel": "WhatsApp", "date": log_day, "summary": note, "next": ""}

            intel_rows = []
            if not args.no_ai and not args.dry_run and any(m["type"] in WA_TEXT and INTEL_HINT.search(m["text"]) for m in theirs):
                convo = [{"time": datetime.fromtimestamp(m["ts"]).strftime("%Y-%m-%d %H:%M"), "me": m["me"],
                          "text": ((m["who"] + "：") if group and not m["me"] else "") + m["text"][:400]}
                         for m in msgs[-60:] if m["type"] in WA_TEXT and m["text"]]
                out = sb.fn("extract", {"contactName": c["name"], "contactCompany": c.get("company") or "", "messages": convo}) or {}
                intel_rows = [{"contact_id": c["id"], "contact_name": c["name"], "date": it.get("date") or log_day,
                               "category": it.get("category") or "其他", "content": it["content"], "source": "WhatsApp自动"}
                              for it in (out.get("items") or [])[:8]]

            if not args.dry_run:
                sb.update("contacts", "id=eq." + urllib.parse.quote(c["id"]), patch)
                sb.insert("logs", [log])
                if intel_rows:
                    sb.insert("intel", intel_rows)
                since_all[jid] = max([since, *[m["ts"] for m in msgs], *[x[0] for x in mine_calls]])
                c.update(patch)
            summary["clients"] += 1; summary["their"] += len(theirs); summary["mine"] += len(mine)
            summary["calls"] += len(talked); summary["logs"] += 1; summary["intel"] += len(intel_rows)
            summary["names"].append(f"{c['name']}（{them_word} {len(theirs)} / 我 {len(mine)}"
                                    + (f"，通话 {len(talked)}" if talked else "")
                                    + (f"，情报 {len(intel_rows)}" if intel_rows else "") + "）"
                                    + "".join(f"\n      · [{r['category']}] {r['content']}" for r in intel_rows))
        for db in dbs.values():
            db.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    if not args.dry_run:
        state["wa_last_run"] = datetime.now().timestamp()
    return summary


def print_whatsapp(s: dict, dry: bool) -> None:
    print(f"WhatsApp 完成{'（试运行，没有写入）' if dry else ''}：{s['clients']} 位客户有新消息（他们发 {s['their']} 条，我发 {s['mine']} 条"
          + (f"，通话 {s['calls']} 次" if s["calls"] else "") + f"），记了 {s['logs']} 笔，提取情报 {s['intel']} 条。")
    for n in s["names"]:
        print("  - " + n)
    if s["unknown"]:
        print("  不在客户簿里的新会话（没有同步，要加的话说一声）：" + "、".join(s["unknown"]))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", nargs="?", choices=["login"])
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-ai", action="store_true")
    ap.add_argument("--no-wechat", action="store_true", help="这次不刷新微信")
    ap.add_argument("--no-whatsapp", action="store_true", help="这次不刷新 WhatsApp")
    ap.add_argument("--since", help="只同步这个时间之后的消息，比如 2026-10-26 14:35:00（覆盖记录的进度）")
    ap.add_argument("--redo-intel", action="store_true", help="用现在的规则重做 --since（默认导出之后）以来自动提取的情报（只管微信）")
    args = ap.parse_args()
    if args.cmd == "login":
        return cmd_login()

    sb = signed_in()
    state = load_json(STATE_FILE, {})
    if not args.no_wechat:
        try:
            sync_wechat(sb, state, args)
        except SystemExit as e:
            if args.redo_intel or args.no_whatsapp:
                raise
            print(f"微信这次没刷新：{e}")
    if args.redo_intel or args.no_whatsapp:
        return
    print("· 读 WhatsApp…", flush=True)
    try:
        s = sync_whatsapp(sb, state, args)
    except SystemExit as e:
        return print(f"WhatsApp 这次没刷新：{e}")
    if not args.dry_run:
        save_private(STATE_FILE, state)
    print_whatsapp(s, args.dry_run)


def sync_wechat(sb: Supabase, state: dict, args) -> None:
    vault = load_vault()
    print("· 增量解密微信…", flush=True)
    decrypt_incremental()
    dec = vault.resolve_decrypted_dir(None)
    wx_contacts, _ = vault.load_contacts(dec)
    sessions = [s for s in vault.session_rows(dec, False, None) if not s["is_group"] and not s["username"].startswith("gh_")]

    crm = {c["id"]: c for c in sb.select("contacts", "select=id,name,company,tier,last_their,last_touch,my_samples&limit=2000")}
    since_all = state.setdefault("since", {})
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
        state["last_run"] = datetime.now().isoformat(timespec="seconds")
        save_private(STATE_FILE, state)
    head = "（试运行，没有写入）" if args.dry_run else ""
    print(f"微信完成{head}：{summary['clients']} 位客户有新消息（他发 {summary['their']} 条，我发 {summary['mine']} 条），"
          f"记了 {summary['logs']} 笔，提取情报 {summary['intel']} 条，新建客户 {summary['new']} 位。")
    for n in summary["names"]:
        print("  - " + n)
    for p in new_people:
        print(f"  + 新客户：{p['name']}")


if __name__ == "__main__":
    main()
