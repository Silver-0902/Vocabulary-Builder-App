"""Spaced repetition: thin wrapper around the FSRS scheduler (py-fsrs, FSRS-6)."""
import datetime as dt
from fsrs import Scheduler, Card, Rating, State

SCHED = Scheduler(desired_retention=0.9, enable_fuzzing=True)
MATURE_DAYS = 21  # a Review card whose stability >= 21 days is "mature / mastered"

def utcnow():
    return dt.datetime.now(dt.timezone.utc)

def iso(d):
    return d.astimezone(dt.timezone.utc).isoformat()

def parse(s):
    return dt.datetime.fromisoformat(s)

def row_to_card(row):
    return Card.from_dict({"card_id": 0, "state": row["state"], "step": row["step"], "stability": row["stability"],
                           "difficulty": row["difficulty"], "due": row["due"], "last_review": row["last_review"]})

def status_name(state, stability):
    if state == 0: return "new"
    if state == 1: return "learning"
    if state == 3: return "relearning"
    return "mature" if (stability or 0) >= MATURE_DAYS else "review"

def review(card, rating, now=None):
    now = now or utcnow()
    new_card, log = SCHED.review_card(card, Rating(rating), now)
    return new_card

def new_card(now=None):
    c = Card()
    c.due = now or utcnow()
    return c
