import os, tempfile, io, datetime as dt, pytest
os.environ["VOCAB_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
from fastapi.testclient import TestClient
from app import main, db as D, srs

@pytest.fixture(scope="module")
def env():
    D.init()
    with D.db() as c:
        c.execute("INSERT INTO users(username,name,role,pw_hash) VALUES('teach','Teacher','teacher',?)", (D.hash_pw("teachpass"),))
    t = TestClient(main.app); assert t.post("/api/login", json={"username": "teach", "password": "teachpass"}).status_code == 200
    return t

def login(u, p):
    c = TestClient(main.app); r = c.post("/api/login", json={"username": u, "password": p}); return c, r

def test_seed_counts(env):
    o = env.get("/api/teacher/overview").json()
    got = {l["level"]: (len(l["topics"]), l["cards"]) for l in o["levels"]}
    assert got == {"A2": (10, 246), "B1": (10, 219), "B2": (20, 423)}
    assert env.get("/api/teacher/cards?level=B2&limit=2000").json().__len__() == 423

def test_auth_rules(env):
    assert TestClient(main.app).get("/api/me").status_code == 401
    assert login("teach", "bad")[1].status_code == 401
    assert env.post("/api/teacher/students", json={"username": "ab", "name": "x", "password": "123456", "level": "A2"}).status_code == 422

def mk_student(env, name, level="A2", group=None):
    r = env.post("/api/teacher/students", json={"username": name, "name": name.title(), "password": "secret12", "level": level, "group_id": group})
    assert r.status_code == 200, r.text
    c, r = login(name, "secret12"); assert r.status_code == 200
    return c

def test_unpublished_cards_hidden_then_visible(env):
    s = mk_student(env, "ali")
    assert s.get("/api/student/vocabulary").json() == []          # all drafts
    assert env.post("/api/teacher/publish", json={"scope": "level", "id": "A2"}).json()["updated"] == 246
    v = s.get("/api/student/vocabulary").json()
    assert len(v) == 246 and all(x["level"] == "A2" for x in v)   # no mixing of levels

def test_students_cannot_use_teacher_api(env):
    s = mk_student(env, "bobur")
    assert s.get("/api/teacher/students").status_code == 403
    assert s.post("/api/teacher/cards/move", json={"card_ids": ["a2-0001"], "from_topic_id": 1, "to_topic_id": 2}).status_code == 403
    assert s.patch("/api/teacher/cards/a2-0001", json={"uz": "x"}).status_code == 403

def test_fsrs_buttons_and_progress_separation(env):
    ali, bob = login("ali", "secret12")[0], login("bobur", "secret12")[0]
    cid = ali.get("/api/student/session?mode=learn").json()["cards"][0]["id"]
    due = {}
    for rating in (1, 2, 3, 4):
        s = mk_student(env, f"rate{rating}")
        r = s.post("/api/student/answer", json={"card_id": cid, "rating": rating}).json()
        due[rating] = dt.datetime.fromisoformat(r["due"]); 
        if rating == 4: assert r["status"] == "review"
        else: assert r["status"] == "learning"
    now = dt.datetime.now(dt.timezone.utc)
    mins = {k: (v - now).total_seconds() / 60 for k, v in due.items()}
    assert mins[1] < mins[2] < mins[3] < mins[4] and mins[4] > 24 * 60 * 5   # Again < Hard < Good < Easy (days for Easy)
    # Ali's own review does not touch Bobur's card state
    ali.post("/api/student/answer", json={"card_id": cid, "rating": 3})
    assert [c for c in bob.get("/api/student/vocabulary").json() if c["id"] == cid][0]["status"] == "new"
    assert [c for c in ali.get("/api/student/vocabulary").json() if c["id"] == cid][0]["status"] == "learning"

def test_interval_growth_and_lapse(env):
    s = mk_student(env, "carim")
    cid = s.get("/api/student/session?mode=learn").json()["cards"][0]["id"]
    s.post("/api/student/answer", json={"card_id": cid, "rating": 4})            # Easy -> Review, days away
    with D.db() as c:
        row = c.execute("SELECT * FROM progress WHERE student_id=(SELECT id FROM users WHERE username='carim') AND card_id=?", (cid,)).fetchone()
        st1 = row["stability"]
        past = srs.iso(srs.utcnow() - dt.timedelta(days=1)); lr = srs.iso(srs.utcnow() - dt.timedelta(days=9)); c.execute("UPDATE progress SET due=?,last_review=? WHERE card_id=? AND student_id=?", (past, lr, cid, row["student_id"]))
    due_before = s.get("/api/student/dashboard").json()["due"]; assert due_before == 1
    r = s.post("/api/student/answer", json={"card_id": cid, "rating": 3}).json()    # Good on time -> longer interval
    with D.db() as c:
        row = c.execute("SELECT * FROM progress WHERE card_id=? AND student_id=?", (cid, row["student_id"])).fetchone()
        assert row["stability"] > st1 and row["state"] == 2
        lr2 = srs.iso(srs.utcnow() - dt.timedelta(days=12)); c.execute("UPDATE progress SET due=?,last_review=? WHERE card_id=? AND student_id=?", (past, lr2, cid, row["student_id"]))
    r = s.post("/api/student/answer", json={"card_id": cid, "rating": 1}).json()     # Again -> relearning, short, lapse counted
    assert r["status"] == "relearning" and r["requeue"] is True
    with D.db() as c:
        row = c.execute("SELECT * FROM progress WHERE card_id=? AND student_id=?", (cid, row["student_id"])).fetchone()
        assert row["lapses"] == 1 and row["reps"] == 3
        assert c.execute("SELECT COUNT(*) FROM review_log WHERE card_id=?", (cid,)).fetchone()[0] >= 3

def test_daily_new_limit_and_review_priority(env):
    s = mk_student(env, "dana")
    s.patch("/api/me/settings", json={"daily_new": 3})
    q = s.get("/api/student/session?mode=learn").json(); assert len(q["cards"]) == 3
    for c in q["cards"]: s.post("/api/student/answer", json={"card_id": c["id"], "rating": 3})
    q = s.get("/api/student/session?mode=learn").json(); assert q["cards"] == [] and q["new_quota_left"] == 0
    d = s.get("/api/student/dashboard").json(); assert d["new_recommended"] == 0 and d["new_today"] == 3 and d["streak"] == 1
    s.patch("/api/me/settings", json={"daily_new": 5}); assert len(s.get("/api/student/session?mode=learn").json()["cards"]) == 2

def test_preview_and_extra_practice(env):
    s = login("dana", "secret12")[0]
    cid = s.get("/api/student/vocabulary").json()
    studied = [c for c in cid if c["status"] != "new"][0]["id"]
    p = s.get(f"/api/student/preview?card_id={studied}").json(); assert set(p) == {"1", "2", "3", "4"}
    ex = s.get("/api/student/session?mode=extra").json()["cards"]; assert len(ex) >= 1 and all(c["status"] != "new" for c in ex)

def test_assignments_by_group_and_unassigned_hidden(env):
    g = env.post("/api/teacher/groups", json={"name": "Evening B1"}).json()["id"]
    s = mk_student(env, "emil", "B1", g)
    s2 = TestClient(main.app); 
    env.post("/api/teacher/publish", json={"scope": "level", "id": "B1"})
    assert len(s.get("/api/student/vocabulary").json()) == 219
    with D.db() as c: uid = c.execute("SELECT id FROM users WHERE username='emil'").fetchone()[0]
    for a in env.get("/api/teacher/assignments").json():
        if a["student_id"] == uid: env.delete(f"/api/teacher/assignments/{a['id']}")
    assert s.get("/api/student/vocabulary").json() == []                    # nothing assigned
    topics = [t["id"] for t in env.get("/api/teacher/overview").json()["levels"][1]["topics"]][:2]
    assert env.post("/api/teacher/assignments", json={"topic_ids": topics, "group_ids": [g]}).json()["created"] == 2
    v = s.get("/api/student/vocabulary").json(); assert 30 < len(v) < 60
    cid = [x for x in env.get("/api/teacher/cards?level=B2").json()][0]["id"]
    assert s.post("/api/student/answer", json={"card_id": cid, "rating": 3}).status_code == 404   # B2 card not available

def test_cloze(env):
    from app.cloze import make_cloze
    assert make_cloze("curly hair", "She has long, curly hair.") == ("She has long, _____.", "curly hair")
    assert make_cloze("If I were you, I'd …", "If I were you, I'd talk to your manager.")[0].startswith("_____ talk")
    assert make_cloze("zebra", "No such word here.") is None
    assert make_cloze("give up", "He never gives up.") is not None

def test_teacher_crud_move_import_export(env):
    ov = env.get("/api/teacher/overview").json()["levels"][0]["topics"]
    t1, t2 = ov[0]["id"], ov[1]["id"]
    r = env.post("/api/teacher/cards", json={"level": "A2", "topic_id": t1, "en": "teapot", "uz": "choynak", "ex": "The teapot is hot.", "ex_uz": "Choynak issiq."}); assert r.status_code == 200
    cid = r.json()["id"]; assert r.json()["status"] == "draft"
    assert env.post("/api/teacher/cards", json={"level": "A2", "topic_id": t1, "en": "TEAPOT", "uz": "x"}).status_code == 409
    assert env.patch(f"/api/teacher/cards/{cid}", json={"definition": "A pot for tea", "pos": "noun"}).json()["definition"] == "A pot for tea"
    assert env.post("/api/teacher/cards/move", json={"card_ids": [cid], "from_topic_id": t1, "to_topic_id": t2}).json()["moved"] == 1
    assert [t["id"] for t in env.get("/api/teacher/cards?q=teapot").json()[0]["topics"]] == [t2]
    b2topic = env.get("/api/teacher/overview").json()["levels"][2]["topics"][0]["id"]
    assert env.post("/api/teacher/cards/move", json={"card_ids": [cid], "from_topic_id": t2, "to_topic_id": b2topic}).status_code == 400
    nt = env.post("/api/teacher/topics", json={"level": "A2", "title": "Hobbies"}).json()["id"]
    assert env.delete(f"/api/teacher/topics/{t2}").status_code == 400                   # not empty
    assert env.delete(f"/api/teacher/topics/{nt}").status_code == 200
    csvtxt = "level,topic,english,uzbek,definition,pos,example,example_uzbek\nA2,Hobbies,chess,shaxmat,a board game,noun,I play chess.,Men shaxmat o'ynayman.\nA2,Hobbies,teapot,choynak,,,,\nXX,Bad,a,b,,,,\nB1,Hobbies B1,,x,,,,\n"
    f = {"file": ("v.csv", csvtxt.encode(), "text/csv")}
    dry = env.post("/api/teacher/import", files=f, data={"mode": "skip", "dry_run": "true"}).json()
    assert dry["added"] == 1 and dry["skipped"] == 1 and len(dry["errors"]) == 2
    assert env.get("/api/teacher/cards?q=chess").json() == []                            # dry run wrote nothing
    real = env.post("/api/teacher/import", files={"file": ("v.csv", csvtxt.encode(), "text/csv")}, data={"mode": "skip", "dry_run": "false"}).json()
    assert real["added"] == 1 and real["topics_created"] == 1
    assert env.get("/api/teacher/cards?q=chess").json()[0]["pos"] == "noun"
    ex = env.get("/api/teacher/export/vocab.csv"); assert ex.status_code == 200 and "chess" in ex.text and "shaxmat" in ex.text
    assert len(env.get("/api/teacher/export/vocab.json").json()) > 900
    j = env.post("/api/teacher/import", files={"file": ("v.json", b'[{"level":"B1","topic":"Identity & Lifestyle","english":"zeitgeist","uzbek":"davr ruhi"}]', "application/json")}, data={"mode": "skip", "dry_run": "false"}).json()
    assert j["added"] == 1

def test_teacher_sees_student_stats_and_difficult(env):
    s = login("dana", "secret12")[0]
    cid = s.get("/api/student/session?mode=extra").json()["cards"][0]["id"]
    for _ in range(3): s.post("/api/student/answer", json={"card_id": cid, "rating": 1})
    st = [x for x in env.get("/api/teacher/students").json() if x["username"] == "dana"][0]
    assert st["totals"]["seen"] >= 3 and st["reviews"] >= 6 and st["streak"] == 1
    d = env.get("/api/teacher/difficult").json(); assert d and d[0]["pct_again"] > 0
    csvp = env.get("/api/teacher/export/progress.csv"); assert "dana" in csvp.text
    det = env.get(f"/api/teacher/students/{st['id']}").json(); assert det["hardest"] and det["topics"]

def test_password_reset_and_deactivate(env):
    sid = [x for x in env.get("/api/teacher/students").json() if x["username"] == "ali"][0]["id"]
    assert env.patch(f"/api/teacher/students/{sid}", json={"password": "newsecret1"}).status_code == 200
    assert login("ali", "secret12")[1].status_code == 401 and login("ali", "newsecret1")[1].status_code == 200
    env.patch(f"/api/teacher/students/{sid}", json={"active": False}); assert login("ali", "newsecret1")[1].status_code == 401

def test_persistence_across_restart(env):
    with D.db() as c: n = c.execute("SELECT COUNT(*) FROM progress").fetchone()[0]
    D.init(); assert n > 0
    with D.db() as c: assert c.execute("SELECT COUNT(*) FROM progress").fetchone()[0] == n
