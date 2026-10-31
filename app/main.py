import csv, io, json, os, re, secrets, time, datetime as dt
from collections import defaultdict
from typing import Optional, List
from fastapi import FastAPI, Depends, HTTPException, Request, Response, UploadFile, File, Form, Query
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from . import db as D
from . import srs
from .cloze import make_cloze

LEVELS = ("A2", "B1", "B2")

STATIC = os.path.join(os.path.dirname(__file__), "..", "static")

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app):
    _startup()
    yield

def _startup():
    D.init()
    with D.db() as c:
        if c.execute("SELECT COUNT(*) FROM users WHERE role='teacher'").fetchone()[0] == 0:
            u = os.environ.get("TEACHER_USERNAME")
            p = os.environ.get("TEACHER_PASSWORD")
            if u and p:
                c.execute("INSERT INTO users(username,name,role,pw_hash) VALUES(?,?,?,?)", (u, "Teacher", "teacher", D.hash_pw(p)))
            else:
                print("No teacher account yet. Create one:  python -m app.manage create-teacher USERNAME PASSWORD")

app = FastAPI(title="Vocabulary Trainer", lifespan=lifespan)

# ---------------------------------------------------------------- auth
_attempts = defaultdict(list)

def current_user(request: Request):
    tok = request.cookies.get("sid")
    if not tok:
        raise HTTPException(401, "Not logged in")
    with D.db() as c:
        r = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1",
                      (tok, srs.iso(srs.utcnow()))).fetchone()
    if not r:
        raise HTTPException(401, "Session expired")
    return dict(r)

def teacher(u=Depends(current_user)):
    if u["role"] != "teacher":
        raise HTTPException(403, "Teacher only")
    return u

def student(u=Depends(current_user)):
    if u["role"] != "student":
        raise HTTPException(403, "Student only")
    return u

class LoginIn(BaseModel):
    username: str
    password: str

@app.post("/api/login")
def login(b: LoginIn, request: Request, resp: Response):
    key = (request.client.host if request.client else "?") + "|" + b.username.lower()
    now = time.time()
    _attempts[key] = [t for t in _attempts[key] if now - t < 300]
    if len(_attempts[key]) >= 10:
        raise HTTPException(429, "Too many attempts. Try again in a few minutes.")
    with D.db() as c:
        u = c.execute("SELECT * FROM users WHERE username=? AND active=1", (b.username.strip(),)).fetchone()
        if not u or not D.check_pw(b.password, u["pw_hash"]):
            _attempts[key].append(now)
            raise HTTPException(401, "Wrong username or password")
        tok = secrets.token_urlsafe(32)
        c.execute("INSERT INTO sessions VALUES(?,?,?)", (tok, u["id"], srs.iso(srs.utcnow() + dt.timedelta(days=30))))
    resp.set_cookie("sid", tok, httponly=True, samesite="lax", max_age=30 * 86400, secure=os.environ.get("VOCAB_HTTPS") == "1")
    return me_payload(dict(u))

@app.post("/api/logout")
def logout(request: Request, resp: Response):
    tok = request.cookies.get("sid")
    if tok:
        with D.db() as c:
            c.execute("DELETE FROM sessions WHERE token=?", (tok,))
    resp.delete_cookie("sid")
    return {"ok": True}

def me_payload(u):
    return {k: u[k] for k in ("id", "username", "name", "role", "level", "daily_new", "theme", "direction", "tz_offset")}

@app.get("/api/me")
def me(u=Depends(current_user)):
    return me_payload(u)

class SettingsIn(BaseModel):
    daily_new: Optional[int] = Field(None, ge=0, le=1000)   # 1000 = no limit
    theme: Optional[str] = Field(None, pattern="^(light|dark)$")
    direction: Optional[str] = Field(None, pattern="^(en2uz|uz2en|cloze|mixed)$")
    tz_offset: Optional[int] = Field(None, ge=-720, le=840)
    name: Optional[str] = Field(None, min_length=1, max_length=60)

@app.patch("/api/me/settings")
def settings(b: SettingsIn, u=Depends(current_user)):
    ch = {k: v for k, v in b.model_dump().items() if v is not None}
    if u["role"] == "teacher":
        ch.pop("daily_new", None)
    with D.db() as c:
        for k, v in ch.items():
            c.execute(f"UPDATE users SET {k}=? WHERE id=?", (v, u["id"]))
        r = c.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    return me_payload(dict(r))

class PwIn(BaseModel):
    old: str
    new: str = Field(min_length=6, max_length=100)

@app.post("/api/me/password")
def change_pw(b: PwIn, u=Depends(current_user)):
    if not D.check_pw(b.old, u["pw_hash"]):
        raise HTTPException(400, "Current password is wrong")
    with D.db() as c:
        c.execute("UPDATE users SET pw_hash=? WHERE id=?", (D.hash_pw(b.new), u["id"]))
    return {"ok": True}

# ---------------------------------------------------------------- helpers
def local_day_start_utc(u, days_ago=0):
    now = srs.utcnow()
    off = dt.timedelta(minutes=u["tz_offset"])
    local = now + off
    start_local = local.replace(hour=0, minute=0, second=0, microsecond=0) - dt.timedelta(days=days_ago)
    return start_local - off

def local_date(u, ts):
    return (srs.parse(ts) + dt.timedelta(minutes=u["tz_offset"])).date()

CARD_COLS = "c.id,c.level,c.en,c.uz,c.definition,c.pos,c.ex,c.ex_uz,c.note,c.pron,c.productive,c.seq"
PROG_COLS = "p.state AS p_state,p.step AS p_step,p.stability AS p_stab,p.difficulty AS p_diff,p.due AS p_due,p.last_review AS p_last,p.reps AS p_reps,p.lapses AS p_lapses,p.first_seen AS p_first"

def visible_rows(c, u, topic_id=None):
    """Cards the student may see (published cards in topics assigned to them or their group), with their own progress."""
    q = f"""SELECT {CARD_COLS},{PROG_COLS},ct.topic_id,t.title AS topic,t.no AS topic_no,ct.category
            FROM cards c JOIN card_topics ct ON ct.card_id=c.id JOIN topics t ON t.id=ct.topic_id
            JOIN assignments a ON a.topic_id=t.id AND (a.student_id=:sid OR (a.group_id IS NOT NULL AND a.group_id=:gid))
            LEFT JOIN progress p ON p.card_id=c.id AND p.student_id=:sid
            WHERE c.status='published'"""
    args = {"sid": u["id"], "gid": u["group_id"]}
    if topic_id:
        q += " AND ct.topic_id=:tid"
        args["tid"] = topic_id
    q += " ORDER BY t.level,t.no,c.seq"
    return [dict(r) for r in c.execute(q, args).fetchall()]

def shape(r):
    st = r["p_state"] or 0
    cl = make_cloze(r["en"], r["ex"])
    return {"id": r["id"], "level": r["level"], "en": r["en"], "uz": r["uz"], "definition": r["definition"], "pos": r["pos"],
            "ex": r["ex"], "ex_uz": r["ex_uz"], "note": r["note"], "productive": bool(r["productive"]),
            "topic_id": r["topic_id"], "topic": r["topic"], "category": r["category"],
            "status": srs.status_name(st, r["p_stab"]), "due": r["p_due"] if st else None, "reps": r["p_reps"] or 0, "lapses": r["p_lapses"] or 0,
            "cloze": cl[0] if cl else None, "cloze_answer": cl[1] if cl else None}

def unique_cards(rows):
    seen, out = set(), []
    for r in rows:
        if r["id"] not in seen:
            seen.add(r["id"]); out.append(r)
    return out

def introduced_today(c, u):
    return c.execute("SELECT COUNT(*) FROM progress WHERE student_id=? AND first_seen>=?", (u["id"], srs.iso(local_day_start_utc(u)))).fetchone()[0]

def streak_days(c, u):
    rows = c.execute("SELECT DISTINCT ts FROM review_log WHERE student_id=?", (u["id"],)).fetchall()
    days = {local_date(u, r["ts"]) for r in rows}
    today = (srs.utcnow() + dt.timedelta(minutes=u["tz_offset"])).date()
    d = today if today in days else today - dt.timedelta(days=1)
    n = 0
    while d in days:
        n += 1; d -= dt.timedelta(days=1)
    return n, today in days

def counts(rows, now_iso):
    rows = unique_cards(rows)
    c = {"total": len(rows), "new": 0, "learning": 0, "review": 0, "relearning": 0, "mature": 0, "due": 0}
    for r in rows:
        s = srs.status_name(r["p_state"] or 0, r["p_stab"])
        c[s] += 1
        if (r["p_state"] or 0) != 0 and r["p_due"] <= now_iso:
            c["due"] += 1
    c["seen"] = c["total"] - c["new"]
    c["pct"] = round(100 * c["mature"] / c["total"]) if c["total"] else 0
    c["started_pct"] = round(100 * c["seen"] / c["total"]) if c["total"] else 0
    return c

# ---------------------------------------------------------------- student
@app.get("/api/student/dashboard")
def s_dashboard(u=Depends(student)):
    now = srs.iso(srs.utcnow())
    with D.db() as c:
        rows = visible_rows(c, u)
        tot = counts(rows, now)
        intro = introduced_today(c, u)
        st, today_done = streak_days(c, u)
        topics = {}
        for r in rows:
            topics.setdefault(r["topic_id"], {"id": r["topic_id"], "title": r["topic"], "level": r["level"], "no": r["topic_no"], "rows": []})["rows"].append(r)
        tl = []
        for t in sorted(topics.values(), key=lambda t: (t["level"], t["no"])):
            tl.append({"id": t["id"], "title": t["title"], "level": t["level"], "no": t["no"], **counts(t["rows"], now)})
        week = []
        for i in range(6, -1, -1):
            a, b = local_day_start_utc(u, i), local_day_start_utc(u, i - 1)
            n = c.execute("SELECT COUNT(*) FROM review_log WHERE student_id=? AND ts>=? AND ts<?", (u["id"], srs.iso(a), srs.iso(b))).fetchone()[0]
            week.append({"date": (a + dt.timedelta(minutes=u["tz_offset"])).strftime("%a %d"), "reviews": n})
        reviews_today = c.execute("SELECT COUNT(*) FROM review_log WHERE student_id=? AND ts>=?", (u["id"], srs.iso(local_day_start_utc(u)))).fetchone()[0]
    quota = max(0, u["daily_new"] - intro)
    new_rec = min(quota, tot["new"])
    return {"level": u["level"], "totals": tot, "due": tot["due"], "new_recommended": new_rec, "new_today": intro, "daily_new": u["daily_new"],
            "est_minutes": max(1, round((tot["due"] + new_rec) * 12 / 60)) if (tot["due"] + new_rec) else 0,
            "streak": st, "studied_today": today_done, "reviews_today": reviews_today, "week": week, "topics": tl}

@app.get("/api/student/vocabulary")
def s_vocab(topic_id: Optional[int] = None, u=Depends(student)):
    with D.db() as c:
        rows = visible_rows(c, u, topic_id)
    return [shape(r) for r in (rows if topic_id else unique_cards(rows))]

@app.get("/api/student/session")
def s_session(mode: str = Query(pattern="^(learn|review|mixed|extra)$"), topic_id: Optional[int] = None, limit: int = Query(40, ge=1, le=200), u=Depends(student)):
    now = srs.iso(srs.utcnow())
    with D.db() as c:
        rows = unique_cards(visible_rows(c, u, topic_id))
        intro = introduced_today(c, u)
    if mode == "learn":
        quota = max(0, u["daily_new"] - intro)
        pick = [r for r in rows if (r["p_state"] or 0) == 0][:min(quota, limit)]
    elif mode in ("review", "mixed"):
        pick = sorted([r for r in rows if (r["p_state"] or 0) != 0 and r["p_due"] <= now], key=lambda r: r["p_due"])[:limit]
        if mode == "mixed":
            import random; random.shuffle(pick)
    else:  # extra practice: studied cards that are not due yet, soonest due first
        pick = sorted([r for r in rows if (r["p_state"] or 0) != 0 and r["p_due"] > now], key=lambda r: r["p_due"])[:min(limit, 20)]
    return {"mode": mode, "cards": [shape(r) for r in pick], "new_quota_left": max(0, u["daily_new"] - intro)}

class AnswerIn(BaseModel):
    card_id: str
    rating: int = Field(ge=1, le=4)
    mode: str = Field("en2uz", pattern="^(en2uz|uz2en|cloze)$")
    ms: Optional[int] = Field(None, ge=0, le=3600000)

def fmt_interval(due_iso):
    d = srs.parse(due_iso) - srs.utcnow()
    s = d.total_seconds()
    if s < 90: return "<1 min"
    if s < 3600: return f"{round(s/60)} min"
    if s < 86400: return f"{round(s/3600)} h"
    return f"{round(s/86400)} d"

@app.post("/api/student/answer")
def s_answer(b: AnswerIn, u=Depends(student)):
    with D.db() as c:
        ok = [r for r in visible_rows(c, u) if r["id"] == b.card_id]
        if not ok:
            raise HTTPException(404, "Card not available")
        row = c.execute("SELECT * FROM progress WHERE student_id=? AND card_id=?", (u["id"], b.card_id)).fetchone()
        now = srs.utcnow()
        if row:
            card, st_before = srs.row_to_card(row), row["state"]
        else:
            card, st_before = srs.new_card(now), 0
        new = srs.review(card, b.rating, now)
        d = new.to_dict()
        recog, recall = (1, 0) if b.mode == "en2uz" else (0, 1)
        lapse = 1 if (st_before == 2 and b.rating == 1) else 0
        if row:
            c.execute("""UPDATE progress SET state=?,step=?,stability=?,difficulty=?,due=?,last_review=?,reps=reps+1,lapses=lapses+?,
                         recog_n=recog_n+?,recall_n=recall_n+? WHERE student_id=? AND card_id=?""",
                      (d["state"], d["step"], d["stability"], d["difficulty"], d["due"], d["last_review"], lapse, recog, recall, u["id"], b.card_id))
        else:
            c.execute("INSERT INTO progress(student_id,card_id,state,step,stability,difficulty,due,last_review,reps,lapses,first_seen,recog_n,recall_n) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (u["id"], b.card_id, d["state"], d["step"], d["stability"], d["difficulty"], d["due"], d["last_review"], 1, lapse, srs.iso(now), recog, recall))
        c.execute("INSERT INTO review_log(student_id,card_id,ts,rating,mode,state_before,due_after,ms) VALUES(?,?,?,?,?,?,?,?)",
                  (u["id"], b.card_id, srs.iso(now), b.rating, b.mode, st_before, d["due"], b.ms))
    return {"card_id": b.card_id, "status": srs.status_name(d["state"], d["stability"]), "due": d["due"], "next_in": fmt_interval(d["due"]),
            "requeue": (srs.parse(d["due"]) - now).total_seconds() <= 20 * 60}

@app.get("/api/student/preview")
def s_preview(card_id: str, u=Depends(student)):
    """Next interval for each of the four buttons (shown on the buttons, like Anki)."""
    with D.db() as c:
        if not [r for r in visible_rows(c, u) if r["id"] == card_id]:
            raise HTTPException(404, "Card not available")
        row = c.execute("SELECT * FROM progress WHERE student_id=? AND card_id=?", (u["id"], card_id)).fetchone()
    now = srs.utcnow()
    out = {}
    for r in (1, 2, 3, 4):
        card = srs.row_to_card(row) if row else srs.new_card(now)
        out[r] = fmt_interval(srs.review(card, r, now).to_dict()["due"])
    return out

class ActIn(BaseModel):
    card_id: str
    activity: str = Field(pattern="^(mc|type|cloze|match|reverse)$")
    correct: bool

@app.post("/api/student/activity")
def s_activity(items: List[ActIn], u=Depends(student)):
    with D.db() as c:
        ids = {r["id"] for r in visible_rows(c, u)}
        n = 0
        for b in items[:100]:
            if b.card_id in ids:
                c.execute("INSERT INTO activity_log(student_id,card_id,ts,activity,correct) VALUES(?,?,?,?,?)",
                          (u["id"], b.card_id, srs.iso(srs.utcnow()), b.activity, int(b.correct))); n += 1
    return {"saved": n}

@app.get("/api/student/progress")
def s_progress(u=Depends(student)):
    now = srs.iso(srs.utcnow())
    with D.db() as c:
        rows = visible_rows(c, u)
        tot = counts(rows, now)
        days = []
        for i in range(29, -1, -1):
            a, b = local_day_start_utc(u, i), local_day_start_utc(u, i - 1)
            r = c.execute("SELECT COUNT(*) n, SUM(rating>1) g FROM review_log WHERE student_id=? AND ts>=? AND ts<?", (u["id"], srs.iso(a), srs.iso(b))).fetchone()
            days.append({"date": (a + dt.timedelta(minutes=u["tz_offset"])).strftime("%d %b"), "reviews": r["n"], "correct": r["g"] or 0})
        tot_rev = c.execute("SELECT COUNT(*) n, SUM(rating>1) g FROM review_log WHERE student_id=?", (u["id"],)).fetchone()
        rr = c.execute("SELECT SUM(recog_n) a, SUM(recall_n) b FROM progress WHERE student_id=?", (u["id"],)).fetchone()
        acts = c.execute("SELECT activity, COUNT(*) n, SUM(correct) k FROM activity_log WHERE student_id=? GROUP BY activity", (u["id"],)).fetchall()
        hard = c.execute("""SELECT c.id,c.en,c.uz,p.lapses,p.reps FROM progress p JOIN cards c ON c.id=p.card_id
                            WHERE p.student_id=? AND p.reps>0 ORDER BY p.lapses DESC,
                            (SELECT COUNT(*) FROM review_log r WHERE r.student_id=p.student_id AND r.card_id=p.card_id AND r.rating=1) DESC LIMIT 10""", (u["id"],)).fetchall()
        st, _ = streak_days(c, u)
    return {"totals": tot, "days": days, "reviews_total": tot_rev["n"], "accuracy": round(100 * (tot_rev["g"] or 0) / tot_rev["n"]) if tot_rev["n"] else None,
            "recognition_reviews": rr["a"] or 0, "recall_reviews": rr["b"] or 0,
            "activities": [{"activity": a["activity"], "n": a["n"], "correct": a["k"]} for a in acts], "hardest": [dict(h) for h in hard if h["lapses"] > 0], "streak": st}

# ---------------------------------------------------------------- teacher: vocabulary
class CardIn(BaseModel):
    level: str = Field(pattern="^(A2|B1|B2)$")
    topic_id: int
    category: str = ""
    en: str = Field(min_length=1, max_length=200)
    uz: str = Field(min_length=1, max_length=300)
    definition: str = Field("", max_length=500)
    pos: str = Field("", max_length=40)
    ex: str = Field("", max_length=400)
    ex_uz: str = Field("", max_length=400)
    note: str = Field("", max_length=500)
    pron: str = Field("", max_length=100)
    productive: bool = False

class CardPatch(BaseModel):
    en: Optional[str] = Field(None, min_length=1, max_length=200)
    uz: Optional[str] = Field(None, min_length=1, max_length=300)
    definition: Optional[str] = Field(None, max_length=500)
    pos: Optional[str] = Field(None, max_length=40)
    ex: Optional[str] = Field(None, max_length=400)
    ex_uz: Optional[str] = Field(None, max_length=400)
    note: Optional[str] = Field(None, max_length=500)
    pron: Optional[str] = Field(None, max_length=100)
    productive: Optional[bool] = None
    status: Optional[str] = Field(None, pattern="^(draft|published)$")
    category: Optional[str] = None
    topic_id: Optional[int] = None

def admin_card(c, r):
    d = dict(r)
    d["topics"] = [dict(x) for x in c.execute("SELECT t.id,t.title,t.no,ct.category FROM card_topics ct JOIN topics t ON t.id=ct.topic_id WHERE ct.card_id=? ORDER BY t.no", (d["id"],))]
    d["needs_review"] = [f for f in d["flags"].split(";") if f] + (["no definition"] if not d["definition"] else []) + (["no part of speech"] if not d["pos"] else [])
    return d

@app.get("/api/teacher/overview")
def t_overview(u=Depends(teacher)):
    with D.db() as c:
        lv = []
        for L in LEVELS:
            ts = c.execute("""SELECT t.id,t.no,t.title,t.kind,COUNT(DISTINCT ct.card_id) n,
                              COUNT(DISTINCT CASE WHEN c.status='published' THEN c.id END) pub,
                              COUNT(DISTINCT CASE WHEN c.definition='' THEN c.id END) nodef
                              FROM topics t LEFT JOIN card_topics ct ON ct.topic_id=t.id LEFT JOIN cards c ON c.id=ct.card_id
                              WHERE t.level=? GROUP BY t.id ORDER BY t.no, t.id""", (L,)).fetchall()
            n = c.execute("SELECT COUNT(*) FROM cards WHERE level=?", (L,)).fetchone()[0]
            lv.append({"level": L, "cards": n, "topics": [dict(t) for t in ts]})
        stu = c.execute("SELECT COUNT(*) FROM users WHERE role='student' AND active=1").fetchone()[0]
    return {"levels": lv, "students": stu}

@app.get("/api/teacher/cards")
def t_cards(topic_id: Optional[int] = None, level: Optional[str] = None, q: str = "", status: Optional[str] = None, limit: int = 500, u=Depends(teacher)):
    sql = "SELECT DISTINCT c.* FROM cards c LEFT JOIN card_topics ct ON ct.card_id=c.id WHERE 1=1"
    a = []
    if topic_id: sql += " AND ct.topic_id=?"; a.append(topic_id)
    if level: sql += " AND c.level=?"; a.append(level)
    if status: sql += " AND c.status=?"; a.append(status)
    if q: sql += " AND (c.en LIKE ? OR c.uz LIKE ?)"; a += [f"%{q}%", f"%{q}%"]
    sql += " ORDER BY c.level,c.seq LIMIT ?"; a.append(min(limit, 2000))
    with D.db() as c:
        return [admin_card(c, r) for r in c.execute(sql, a).fetchall()]

def _norm(s): return re.sub(r"\s+", " ", s.strip())

@app.post("/api/teacher/cards")
def t_card_add(b: CardIn, u=Depends(teacher)):
    with D.db() as c:
        t = c.execute("SELECT * FROM topics WHERE id=?", (b.topic_id,)).fetchone()
        if not t or t["level"] != b.level:
            raise HTTPException(400, "Topic does not belong to that level")
        ex = c.execute("SELECT id FROM cards WHERE level=? AND lower(en)=lower(?)", (b.level, _norm(b.en))).fetchone()
        if ex:
            raise HTTPException(409, f"'{b.en}' already exists at {b.level} ({ex['id']}). Edit that card or add its topic instead.")
        cid = f"{b.level.lower()}-{secrets.token_hex(3)}"
        seq = (c.execute("SELECT COALESCE(MAX(seq),0)+1 FROM cards").fetchone()[0])
        c.execute("INSERT INTO cards(id,level,en,uz,definition,pos,ex,ex_uz,note,pron,productive,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                  (cid, b.level, _norm(b.en), _norm(b.uz), b.definition, b.pos, b.ex, b.ex_uz, b.note, b.pron, int(b.productive), seq))
        c.execute("INSERT INTO card_topics VALUES(?,?,?)", (cid, b.topic_id, b.category))
        return admin_card(c, c.execute("SELECT * FROM cards WHERE id=?", (cid,)).fetchone())

@app.patch("/api/teacher/cards/{cid}")
def t_card_edit(cid: str, b: CardPatch, u=Depends(teacher)):
    ch = b.model_dump(exclude_unset=True)
    with D.db() as c:
        if not c.execute("SELECT 1 FROM cards WHERE id=?", (cid,)).fetchone():
            raise HTTPException(404, "No such card")
        topic_id, cat = ch.pop("topic_id", None), ch.pop("category", None)
        if "productive" in ch: ch["productive"] = int(ch["productive"])
        for k, v in ch.items():
            if k in ("en", "uz"): v = _norm(v)
            try:
                c.execute(f"UPDATE cards SET {k}=? WHERE id=?", (v, cid))
            except Exception:
                raise HTTPException(409, "A card with that English text already exists at this level")
        if cat is not None and topic_id:
            c.execute("UPDATE card_topics SET category=? WHERE card_id=? AND topic_id=?", (cat, cid, topic_id))
        return admin_card(c, c.execute("SELECT * FROM cards WHERE id=?", (cid,)).fetchone())

@app.delete("/api/teacher/cards/{cid}")
def t_card_del(cid: str, u=Depends(teacher)):
    with D.db() as c:
        c.execute("DELETE FROM cards WHERE id=?", (cid,))
    return {"ok": True}

class MoveIn(BaseModel):
    card_ids: List[str] = Field(min_length=1)
    from_topic_id: int
    to_topic_id: int

@app.post("/api/teacher/cards/move")
def t_move(b: MoveIn, u=Depends(teacher)):
    with D.db() as c:
        to = c.execute("SELECT * FROM topics WHERE id=?", (b.to_topic_id,)).fetchone()
        if not to: raise HTTPException(404, "Target topic not found")
        n = 0
        for cid in b.card_ids:
            card = c.execute("SELECT level FROM cards WHERE id=?", (cid,)).fetchone()
            if not card or card["level"] != to["level"]:
                raise HTTPException(400, f"{cid}: cards can only move within the same CEFR level")
            cat = c.execute("SELECT category FROM card_topics WHERE card_id=? AND topic_id=?", (cid, b.from_topic_id)).fetchone()
            c.execute("DELETE FROM card_topics WHERE card_id=? AND topic_id=?", (cid, b.from_topic_id))
            c.execute("INSERT OR IGNORE INTO card_topics VALUES(?,?,?)", (cid, b.to_topic_id, cat["category"] if cat else ""))
            n += 1
    return {"moved": n}

class PubIn(BaseModel):
    scope: str = Field(pattern="^(card|topic|level)$")
    id: str
    publish: bool = True

@app.post("/api/teacher/publish")
def t_publish(b: PubIn, u=Depends(teacher)):
    st = "published" if b.publish else "draft"
    with D.db() as c:
        if b.scope == "card":
            cur = c.execute("UPDATE cards SET status=? WHERE id=?", (st, b.id))
        elif b.scope == "topic":
            cur = c.execute("UPDATE cards SET status=? WHERE id IN (SELECT card_id FROM card_topics WHERE topic_id=?)", (st, int(b.id)))
        else:
            cur = c.execute("UPDATE cards SET status=? WHERE level=?", (st, b.id))
    return {"updated": cur.rowcount}

class TopicIn(BaseModel):
    level: str = Field(pattern="^(A2|B1|B2)$")
    title: str = Field(min_length=1, max_length=100)

@app.post("/api/teacher/topics")
def t_topic_add(b: TopicIn, u=Depends(teacher)):
    with D.db() as c:
        if c.execute("SELECT 1 FROM topics WHERE level=? AND lower(title)=lower(?)", (b.level, b.title.strip())).fetchone():
            raise HTTPException(409, "That topic already exists at this level")
        no = c.execute("SELECT COALESCE(MAX(no),0)+1 FROM topics WHERE level=?", (b.level,)).fetchone()[0]
        cur = c.execute("INSERT INTO topics(level,no,title) VALUES(?,?,?)", (b.level, no, b.title.strip()))
        return {"id": cur.lastrowid, "level": b.level, "no": no, "title": b.title.strip()}

class TopicPatch(BaseModel):
    title: str = Field(min_length=1, max_length=100)

@app.patch("/api/teacher/topics/{tid}")
def t_topic_edit(tid: int, b: TopicPatch, u=Depends(teacher)):
    with D.db() as c:
        try:
            c.execute("UPDATE topics SET title=? WHERE id=?", (b.title.strip(), tid))
        except Exception:
            raise HTTPException(409, "That topic name already exists at this level")
    return {"ok": True}

@app.delete("/api/teacher/topics/{tid}")
def t_topic_del(tid: int, u=Depends(teacher)):
    with D.db() as c:
        n = c.execute("SELECT COUNT(*) FROM card_topics WHERE topic_id=?", (tid,)).fetchone()[0]
        if n:
            raise HTTPException(400, f"Topic still has {n} cards. Move or delete them first.")
        c.execute("DELETE FROM topics WHERE id=?", (tid,))
    return {"ok": True}

# ---------------------------------------------------------------- teacher: students, groups, assignments
class StudentIn(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9_.-]+$")
    name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=6, max_length=100)
    level: str = Field(pattern="^(A2|B1|B2)$")
    group_id: Optional[int] = None
    assign_level: bool = True
    daily_new: int = Field(1000, ge=0, le=1000)   # default: no limit, all words of a topic can be learned in one day

@app.post("/api/teacher/students")
def t_student_add(b: StudentIn, u=Depends(teacher)):
    with D.db() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?", (b.username,)).fetchone():
            raise HTTPException(409, "Username already taken")
        cur = c.execute("INSERT INTO users(username,name,role,pw_hash,level,group_id,daily_new) VALUES(?,?,'student',?,?,?,?)",
                        (b.username, b.name, D.hash_pw(b.password), b.level, b.group_id, b.daily_new))
        if b.assign_level:
            for t in c.execute("SELECT id FROM topics WHERE level=?", (b.level,)).fetchall():
                c.execute("INSERT OR IGNORE INTO assignments(topic_id,student_id) VALUES(?,?)", (t["id"], cur.lastrowid))
        return {"id": cur.lastrowid}

class StudentPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    level: Optional[str] = Field(None, pattern="^(A2|B1|B2)$")
    group_id: Optional[int] = None
    active: Optional[bool] = None
    password: Optional[str] = Field(None, min_length=6, max_length=100)
    daily_new: Optional[int] = Field(None, ge=0, le=1000)

@app.patch("/api/teacher/students/{sid}")
def t_student_edit(sid: int, b: StudentPatch, u=Depends(teacher)):
    ch = b.model_dump(exclude_unset=True)
    with D.db() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=? AND role='student'", (sid,)).fetchone():
            raise HTTPException(404, "No such student")
        if "password" in ch:
            c.execute("UPDATE users SET pw_hash=? WHERE id=?", (D.hash_pw(ch.pop("password")), sid))
            c.execute("DELETE FROM sessions WHERE user_id=?", (sid,))
        if "active" in ch:
            c.execute("UPDATE users SET active=? WHERE id=?", (int(ch.pop("active")), sid))
        for k, v in ch.items():
            c.execute(f"UPDATE users SET {k}=? WHERE id=?", (v, sid))
    return {"ok": True}

def student_stats(c, s):
    s = dict(s)
    now = srs.iso(srs.utcnow())
    rows = visible_rows(c, s)
    t = counts(rows, now)
    r = c.execute("SELECT COUNT(*) n, SUM(rating>1) g, MAX(ts) last FROM review_log WHERE student_id=?", (s["id"],)).fetchone()
    wk = c.execute("SELECT COUNT(*) FROM review_log WHERE student_id=? AND ts>=?", (s["id"], srs.iso(srs.utcnow() - dt.timedelta(days=7)))).fetchone()[0]
    st, today = streak_days(c, s)
    g = c.execute("SELECT name FROM groups WHERE id=?", (s["group_id"],)).fetchone() if s["group_id"] else None
    return {"id": s["id"], "username": s["username"], "name": s["name"], "level": s["level"], "group_id": s["group_id"], "group": g["name"] if g else None,
            "active": bool(s["active"]), "daily_new": s["daily_new"], "totals": t, "reviews": r["n"], "accuracy": round(100 * (r["g"] or 0) / r["n"]) if r["n"] else None,
            "last_active": r["last"], "reviews_7d": wk, "streak": st}

@app.get("/api/teacher/students")
def t_students(u=Depends(teacher)):
    with D.db() as c:
        return [student_stats(c, s) for s in c.execute("SELECT * FROM users WHERE role='student' ORDER BY name").fetchall()]

@app.get("/api/teacher/students/{sid}")
def t_student(sid: int, u=Depends(teacher)):
    with D.db() as c:
        s = c.execute("SELECT * FROM users WHERE id=? AND role='student'", (sid,)).fetchone()
        if not s: raise HTTPException(404, "No such student")
        out = student_stats(c, s)
        now = srs.iso(srs.utcnow())
        rows = visible_rows(c, dict(s))
        topics = {}
        for r in rows: topics.setdefault(r["topic_id"], {"title": r["topic"], "no": r["topic_no"], "level": r["level"], "rows": []})["rows"].append(r)
        out["topics"] = [{"title": t["title"], **counts(t["rows"], now)} for t in sorted(topics.values(), key=lambda t: (t["level"], t["no"]))]
        out["hardest"] = [dict(h) for h in c.execute("""SELECT c.en,c.uz,p.lapses,p.reps,
              (SELECT COUNT(*) FROM review_log r WHERE r.student_id=p.student_id AND r.card_id=p.card_id AND r.rating=1) agains
              FROM progress p JOIN cards c ON c.id=p.card_id WHERE p.student_id=? ORDER BY agains DESC, p.lapses DESC LIMIT 10""", (sid,)) if h["agains"] > 0]
        out["recent"] = [dict(r) for r in c.execute("""SELECT r.ts,c.en,r.rating,r.mode FROM review_log r JOIN cards c ON c.id=r.card_id WHERE r.student_id=? ORDER BY r.id DESC LIMIT 15""", (sid,))]
        out["activities"] = [dict(r) for r in c.execute("SELECT activity, COUNT(*) n, SUM(correct) correct FROM activity_log WHERE student_id=? GROUP BY activity", (sid,))]
    return out

class GroupIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)

@app.get("/api/teacher/groups")
def t_groups(u=Depends(teacher)):
    with D.db() as c:
        return [dict(g) | {"members": c.execute("SELECT COUNT(*) FROM users WHERE group_id=?", (g["id"],)).fetchone()[0]} for g in c.execute("SELECT * FROM groups ORDER BY name")]

@app.post("/api/teacher/groups")
def t_group_add(b: GroupIn, u=Depends(teacher)):
    with D.db() as c:
        try:
            cur = c.execute("INSERT INTO groups(name) VALUES(?)", (b.name.strip(),))
        except Exception:
            raise HTTPException(409, "Group already exists")
    return {"id": cur.lastrowid, "name": b.name.strip()}

class AssignIn(BaseModel):
    topic_ids: List[int] = Field(min_length=1)
    student_ids: List[int] = []
    group_ids: List[int] = []

@app.post("/api/teacher/assignments")
def t_assign(b: AssignIn, u=Depends(teacher)):
    if not b.student_ids and not b.group_ids:
        raise HTTPException(400, "Choose at least one student or group")
    n = 0
    with D.db() as c:
        for t in b.topic_ids:
            for s in b.student_ids:
                n += c.execute("INSERT OR IGNORE INTO assignments(topic_id,student_id) VALUES(?,?)", (t, s)).rowcount
            for g in b.group_ids:
                n += c.execute("INSERT OR IGNORE INTO assignments(topic_id,group_id) VALUES(?,?)", (t, g)).rowcount
    return {"created": n}

@app.get("/api/teacher/assignments")
def t_assignments(u=Depends(teacher)):
    with D.db() as c:
        return [dict(r) for r in c.execute("""SELECT a.id,t.level,t.no,t.title topic,a.student_id,a.group_id,us.name student,g.name grp FROM assignments a
            JOIN topics t ON t.id=a.topic_id LEFT JOIN users us ON us.id=a.student_id LEFT JOIN groups g ON g.id=a.group_id ORDER BY t.level,t.no,us.name,g.name""")]

@app.delete("/api/teacher/assignments/{aid}")
def t_unassign(aid: int, u=Depends(teacher)):
    with D.db() as c:
        c.execute("DELETE FROM assignments WHERE id=?", (aid,))
    return {"ok": True}

@app.get("/api/teacher/difficult")
def t_difficult(student_id: Optional[int] = None, limit: int = 30, u=Depends(teacher)):
    sql = """SELECT c.id,c.en,c.uz,c.level,COUNT(*) reviews,SUM(r.rating=1) agains,ROUND(100.0*SUM(r.rating=1)/COUNT(*)) pct_again,COUNT(DISTINCT r.student_id) students
             FROM review_log r JOIN cards c ON c.id=r.card_id {w} GROUP BY c.id HAVING reviews>=2 AND agains>0 ORDER BY pct_again DESC, agains DESC LIMIT ?"""
    with D.db() as c:
        rows = c.execute(sql.format(w="WHERE r.student_id=?" if student_id else ""), ([student_id] if student_id else []) + [limit]).fetchall()
    return [dict(r) for r in rows]

# ---------------------------------------------------------------- import / export
COLMAP = {"level": "level", "topic": "topic", "category": "category", "english": "en", "en": "en", "word": "en", "uzbek": "uz", "uz": "uz", "translation": "uz",
          "definition": "definition", "pos": "pos", "part_of_speech": "pos", "example": "ex", "ex": "ex", "example_uzbek": "ex_uz", "ex_uz": "ex_uz",
          "note": "note", "pronunciation": "pron", "productive": "productive"}

def parse_upload(name, raw):
    text = raw.decode("utf-8-sig")
    if name.lower().endswith(".json"):
        data = json.loads(text)
        data = data["cards"] if isinstance(data, dict) and "cards" in data else data
        if not isinstance(data, list): raise ValueError("JSON must be a list of cards")
        return [{COLMAP.get(str(k).lower().strip(), None): v for k, v in r.items() if COLMAP.get(str(k).lower().strip())} for r in data]
    rd = csv.DictReader(io.StringIO(text))
    return [{COLMAP[k.lower().strip()]: (v or "") for k, v in r.items() if k and k.lower().strip() in COLMAP} for r in rd]

@app.post("/api/teacher/import")
async def t_import(file: UploadFile = File(...), mode: str = Form("skip"), dry_run: str = Form("true"), u=Depends(teacher)):
    raw = await file.read()
    if len(raw) > 5_000_000: raise HTTPException(413, "File too large")
    try:
        rows = parse_upload(file.filename or "x.csv", raw)
    except Exception as e:
        raise HTTPException(400, f"Cannot read file: {e}")
    dry = dry_run.lower() == "true"
    rep = {"rows": len(rows), "added": 0, "updated": 0, "skipped": 0, "topics_created": 0, "errors": []}
    with D.db() as c:
        seq = c.execute("SELECT COALESCE(MAX(seq),0) FROM cards").fetchone()[0]
        for i, r in enumerate(rows, start=2):
            lvl, en, uz, topic = str(r.get("level", "")).strip().upper(), _norm(str(r.get("en", ""))), _norm(str(r.get("uz", ""))), _norm(str(r.get("topic", "")))
            if lvl not in LEVELS: rep["errors"].append(f"row {i}: level must be A2, B1 or B2 (got '{lvl}')"); continue
            if not en or not uz: rep["errors"].append(f"row {i}: english and uzbek are required"); continue
            if not topic: rep["errors"].append(f"row {i}: topic is required"); continue
            t = c.execute("SELECT id FROM topics WHERE level=? AND lower(title)=lower(?)", (lvl, topic)).fetchone()
            if not t:
                rep["topics_created"] += 1
                no = c.execute("SELECT COALESCE(MAX(no),0)+1 FROM topics WHERE level=?", (lvl,)).fetchone()[0]
                tid = c.execute("INSERT INTO topics(level,no,title) VALUES(?,?,?)", (lvl, no, topic)).lastrowid
            else:
                tid = t["id"]
            ex = c.execute("SELECT id FROM cards WHERE level=? AND lower(en)=lower(?)", (lvl, en)).fetchone()
            fields = {k: str(r.get(k, "") or "") for k in ("definition", "pos", "ex", "ex_uz", "note", "pron")}
            prod = int(str(r.get("productive", "")).strip().lower() in ("1", "yes", "true", "y"))
            if ex:
                c.execute("INSERT OR IGNORE INTO card_topics VALUES(?,?,?)", (ex["id"], tid, r.get("category", "") or ""))
                if mode == "update":
                    for k, v in fields.items():
                        if v: c.execute(f"UPDATE cards SET {k}=? WHERE id=?", (v, ex["id"]))
                    c.execute("UPDATE cards SET uz=? WHERE id=?", (uz, ex["id"])); rep["updated"] += 1
                else:
                    rep["skipped"] += 1
            else:
                seq += 1
                cid = f"{lvl.lower()}-{secrets.token_hex(3)}"
                c.execute("INSERT INTO cards(id,level,en,uz,definition,pos,ex,ex_uz,note,pron,productive,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                          (cid, lvl, en, uz, fields["definition"], fields["pos"], fields["ex"], fields["ex_uz"], fields["note"], fields["pron"], prod, seq))
                c.execute("INSERT INTO card_topics VALUES(?,?,?)", (cid, tid, r.get("category", "") or ""))
                rep["added"] += 1
        if dry:
            c.rollback()
            c.execute("BEGIN")
    rep["dry_run"] = dry
    return rep

EXPORT_COLS = ["id", "level", "topic", "category", "english", "uzbek", "definition", "pos", "example", "example_uzbek", "note", "productive", "status"]

@app.get("/api/teacher/export/vocab.{fmt}")
def t_export_vocab(fmt: str, u=Depends(teacher)):
    with D.db() as c:
        rows = [dict(r) for r in c.execute("""SELECT c.id,c.level,t.title topic,ct.category,c.en english,c.uz uzbek,c.definition,c.pos,c.ex example,c.ex_uz example_uzbek,c.note,
               CASE c.productive WHEN 1 THEN 'yes' ELSE '' END productive,c.status FROM cards c JOIN card_topics ct ON ct.card_id=c.id JOIN topics t ON t.id=ct.topic_id
               ORDER BY c.level,t.no,c.seq""")]
    if fmt == "json":
        return Response(json.dumps(rows, ensure_ascii=False, indent=1), media_type="application/json", headers={"Content-Disposition": "attachment; filename=vocabulary.json"})
    if fmt != "csv": raise HTTPException(404)
    return csv_response(rows, EXPORT_COLS, "vocabulary.csv")

def csv_response(rows, cols, name):
    buf = io.StringIO(); w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore"); w.writeheader(); w.writerows(rows)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8", headers={"Content-Disposition": f"attachment; filename={name}"})

@app.get("/api/teacher/export/progress.csv")
def t_export_progress(u=Depends(teacher)):
    out = []
    with D.db() as c:
        for s in c.execute("SELECT * FROM users WHERE role='student' ORDER BY name").fetchall():
            st = student_stats(c, s)
            t = st["totals"]
            out.append({"student": st["name"], "username": st["username"], "level": st["level"], "group": st["group"] or "", "cards_assigned": t["total"], "seen": t["seen"],
                        "new": t["new"], "learning": t["learning"], "review": t["review"], "relearning": t["relearning"], "mature": t["mature"], "due_now": t["due"],
                        "reviews_total": st["reviews"], "reviews_7d": st["reviews_7d"], "accuracy_pct": st["accuracy"] if st["accuracy"] is not None else "", "streak_days": st["streak"], "last_active": st["last_active"] or ""})
    return csv_response(out, list(out[0].keys()) if out else ["student"], "student_progress.csv")

# ---------------------------------------------------------------- static
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(os.path.join(STATIC, "index.html"))

app.mount("/static", StaticFiles(directory=STATIC), name="static")