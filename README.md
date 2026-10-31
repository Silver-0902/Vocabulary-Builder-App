# Vocabulary Trainer (A2 · B1 · B2)

An Anki-style vocabulary platform for one teacher and many students. It is built from the vocabulary tables in your
A2, B1 and B2 interactive workbooks (888 cards, 40 topics).

* **Backend:** Python 3.10+, FastAPI, SQLite (one file, no database server).
* **Spaced repetition:** [FSRS](https://github.com/open-spaced-repetition/py-fsrs) (FSRS-6, `fsrs` package), target retention 90 %.
* **Frontend:** plain HTML/CSS/JS, no build step, no external requests. Light and dark mode, phone friendly.

## Folder structure

```
app/main.py      all API routes (auth, student, teacher, import/export)
app/db.py        schema, seeding, password hashing (scrypt)
app/srs.py       FSRS wrapper, card statuses
app/cloze.py     builds fill-in-the-blank sentences from examples
app/manage.py    command line: create teacher, reset password
static/          index.html, app.js, style.css (the whole interface)
data/seed_cards.json   the 888 extracted cards (loaded once, on first start)
tests/           test_api.py (pytest), e2e.js + run_e2e.sh (real browser test)
Dockerfile
```

## Install and run (your computer)

```bash
cd vocabapp
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m app.manage create-teacher YOURNAME A-STRONG-PASSWORD
uvicorn app.main:app --port 8000 --workers 1
```

Open http://localhost:8000 and log in. The database is created at `data/vocab.db` on first start and the 888 cards are
loaded as **drafts**. (Set `VOCAB_DB=/path/file.db` to put it somewhere else.)

Alternatively create the teacher on first start with `TEACHER_USERNAME=... TEACHER_PASSWORD=... uvicorn ...`.

## First steps as the teacher

1. **Levels & topics**: look through each topic, open a topic to review/edit its cards.
2. Fill in what the source files did not contain: **English definitions and part of speech** (cards show an orange
   "needs review" note). Edit a card, or export CSV, fill the columns in Excel, and re-import with *Update*.
3. **Publish** the topics (or a whole level). Students only ever see published cards.
4. **Students → Add student**: choose a username, a starting password and a level. By default all topics of that
   level are assigned. Tell the student their login. You can reset a password or deactivate an account at any time.
5. **Assignments** lets you give specific topics to individual students or to a group.
6. **Difficult words** and **Students → Open** show what students find hard (based on "Again" answers).

## Importing vocabulary

*Import / export* accepts CSV (UTF-8) or JSON with these columns:
`level, topic, english, uzbek` (required) and `category, definition, pos, example, example_uzbek, note, productive` (optional).
Use **Preview** first: it reports how many cards would be added, skipped or rejected, and writes nothing.
New words arrive as drafts. A word that already exists at that level is skipped (or updated, if you choose that).
A word that appears in several topics is stored once and linked to each topic.

## How learning works

* Each student has their own progress per card (state, stability, difficulty, due date) and a full review log.
* **Learn** introduces new cards up to the student's daily new-word goal. **Review** shows what is due, oldest first.
  Due reviews are never mixed with unlimited new words. "Extra practice" lets students review words that are not due yet.
* Buttons **Again / Hard / Good / Easy** call FSRS. The next interval is shown on each button.
  Statuses: New, Learning, Review, Relearning, Mature (stability of 21 days or more).
* Three flashcard directions: English → Uzbek (recognition), Uzbek → English and context/fill-the-gap (active recall).
  Recognition and recall reviews are counted separately on the Progress page.
* Practice activities (multiple choice, typing, fill the blank, matching, reverse translation, mixed) are logged
  separately and **do not change the review schedule**.

## Tests

```bash
python -m pytest tests -q          # 14 API tests (scheduling, permissions, import/export...)
sh tests/run_e2e.sh                # starts a fresh server and drives a real browser (needs: npm i playwright)
```

## Deploying free on PythonAnywhere (small classes)

PythonAnywhere's free plan has no ASGI server, so `wsgi.py` wraps the app with `a2wsgi`.

1. Create a free "Beginner" account at pythonanywhere.com. Your address will be `https://USERNAME.pythonanywhere.com`.
2. Open a **Bash console**, then:
   ```
   git clone https://github.com/YOU/REPO.git vocabapp     # or upload a zip in the Files tab and unzip it
   cd vocabapp
   mkvirtualenv vocab --python=python3.12
   pip install -r requirements.txt
   python -m app.manage create-teacher YOUR_NAME YOUR_PASSWORD
   ```
3. **Web** tab -> *Add a new web app* -> *Manual configuration* -> Python 3.12.
   - Virtualenv: `/home/USERNAME/.virtualenvs/vocab`
   - Click the WSGI configuration file link, delete everything in it and write:
     ```
     import sys
     sys.path.insert(0, "/home/USERNAME/vocabapp")
     from wsgi import application
     ```
4. Press the green **Reload** button and open your address.
5. Free web apps expire after one month: log in and press the extend button on the Web tab each month.
6. Back up `vocabapp/data/vocab.db` (Files tab -> download) from time to time. It holds all student progress.

## Deploying online

You need a small always-on server with HTTPS, because students log in with passwords.

**Option A: a VPS (Hetzner, DigitalOcean...), about 5 USD/month**
1. Install Python and Caddy (or nginx + certbot). Copy this folder to `/srv/vocabapp`, create the virtualenv, install requirements.
2. Create the teacher (`python -m app.manage create-teacher ...`).
3. Run uvicorn as a service, **one worker**, with `VOCAB_HTTPS=1` (marks the login cookie `Secure`):
   `uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1`
4. Caddy: `vocab.example.com { reverse_proxy 127.0.0.1:8000 }` (Caddy gets the HTTPS certificate automatically).

**Option B: Docker (Render, Fly.io, Railway, any VPS)**
`docker build -t vocab .` then `docker run -p 8000:8000 -v vocabdata:/data -e TEACHER_USERNAME=you -e TEACHER_PASSWORD=... vocab`.
The `/data` volume **must be persistent**: it holds the database. On free tiers without a persistent disk, progress is lost on restart.

**Backups:** copy `vocab.db` regularly (for example `sqlite3 vocab.db ".backup backup.db"` from a nightly cron job).

## Known limitations (please read)

* **SQLite, single process.** Comfortable for dozens to a few hundred students. If you outgrow it, the SQL is plain and
  can move to PostgreSQL. Keep `--workers 1` (the login rate limit is in memory).
* **No e-mail password reset.** The teacher resets passwords. Students can change their own in Settings.
* **Practice results are checked in the student's browser**, then saved. A technical student could fake practice scores.
  Review scheduling is stored and computed on the server, but each rating is the student's own honest self-assessment, as in Anki.
* **Pronunciation** uses the browser's built-in text-to-speech (needs an English voice installed; quality varies). There are no recorded audio files.
* **Content gaps:** definitions and parts of speech are empty (the source files did not contain them). 58 cards have no
  exact headword in their example, so they fall back to a normal flashcard in fill-the-gap mode. Uzbek translations
  come from the workbooks and have not been checked by a native speaker.
* Extra practice and early reviews do update the schedule (FSRS accounts for the early timing).