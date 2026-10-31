import os, sqlite3, json, secrets, hashlib, hmac
from contextlib import contextmanager

DB_PATH = os.environ.get("VOCAB_DB", os.path.join(os.path.dirname(__file__), "..", "data", "vocab.db"))
SEED = os.path.join(os.path.dirname(__file__), "..", "data", "seed_cards.json")

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('teacher','student')), pw_hash TEXT NOT NULL,
  level TEXT CHECK(level IN('A2','B1','B2')), group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  daily_new INTEGER NOT NULL DEFAULT 10, theme TEXT NOT NULL DEFAULT 'light', direction TEXT NOT NULL DEFAULT 'en2uz',
  tz_offset INTEGER NOT NULL DEFAULT 300, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topics(
  id INTEGER PRIMARY KEY, level TEXT NOT NULL CHECK(level IN('A2','B1','B2')), no INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL, kind TEXT DEFAULT '', UNIQUE(level,title));
CREATE TABLE IF NOT EXISTS cards(
  id TEXT PRIMARY KEY, level TEXT NOT NULL CHECK(level IN('A2','B1','B2')), en TEXT NOT NULL, uz TEXT NOT NULL,
  definition TEXT NOT NULL DEFAULT '', pos TEXT NOT NULL DEFAULT '', ex TEXT NOT NULL DEFAULT '', ex_uz TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '', pron TEXT NOT NULL DEFAULT '', productive INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','published')), flags TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL DEFAULT 0, UNIQUE(level,en));
CREATE TABLE IF NOT EXISTS card_topics(card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, category TEXT NOT NULL DEFAULT '', PRIMARY KEY(card_id,topic_id));
CREATE TABLE IF NOT EXISTS assignments(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  CHECK((student_id IS NULL) != (group_id IS NULL)), UNIQUE(topic_id,student_id,group_id));
CREATE TABLE IF NOT EXISTS progress(
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  state INTEGER NOT NULL, step INTEGER, stability REAL, difficulty REAL, due TEXT NOT NULL, last_review TEXT,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL,
  recog_n INTEGER NOT NULL DEFAULT 0, recall_n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(student_id,card_id));
CREATE TABLE IF NOT EXISTS review_log(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, ts TEXT NOT NULL, rating INTEGER NOT NULL, mode TEXT NOT NULL,
  state_before INTEGER NOT NULL, due_after TEXT NOT NULL, ms INTEGER);
CREATE TABLE IF NOT EXISTS activity_log(id INTEGER PRIMARY KEY, student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE, ts TEXT NOT NULL, activity TEXT NOT NULL, correct INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_rl ON review_log(student_id, ts);
CREATE INDEX IF NOT EXISTS ix_pr ON progress(student_id, due);
CREATE INDEX IF NOT EXISTS ix_al ON activity_log(student_id, ts);
"""

def connect():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c

@contextmanager
def db():
    c = connect()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()

def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return salt.hex() + "$" + h.hex()

def check_pw(pw, stored):
    try:
        s, h = stored.split("$")
        cand = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(s), n=2**14, r=8, p=1, dklen=32)
        return hmac.compare_digest(cand.hex(), h)
    except Exception:
        return False

def init(seed=True):
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    with db() as c:
        c.executescript(SCHEMA)
        if seed and c.execute("SELECT COUNT(*) FROM cards").fetchone()[0] == 0 and os.path.exists(SEED):
            d = json.load(open(SEED, encoding="utf-8"))
            tid = {}
            for t in d["topics"]:
                cur = c.execute("INSERT INTO topics(level,no,title,kind) VALUES(?,?,?,?)", (t["level"], t["no"], t["title"], t["type"]))
                tid[(t["level"], t["no"])] = cur.lastrowid
            for i, k in enumerate(d["cards"]):
                flags = ";".join(f for f in k["flags"] if f not in ("no_definition", "no_pos"))
                c.execute("INSERT INTO cards(id,level,en,uz,ex,ex_uz,productive,flags,seq) VALUES(?,?,?,?,?,?,?,?,?)",
                          (k["id"], k["level"], k["en"], k["uz"], k["ex"], k["ex_uz"], int(k["productive"]), flags, i))
                for t in k["topics"]:
                    c.execute("INSERT OR IGNORE INTO card_topics VALUES(?,?,?)", (k["id"], tid[(k["level"], t["topic_no"])], t["category"]))
