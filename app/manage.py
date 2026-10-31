"""python -m app.manage create-teacher USERNAME PASSWORD | reset-password USERNAME PASSWORD | set-daily-new N [USERNAME]
(set-daily-new 1000 = no limit; without USERNAME it applies to all students)"""
import sys
from . import db as D

def main(a):
    D.init()
    with D.db() as c:
        if a[0] == "create-teacher":
            c.execute("INSERT INTO users(username,name,role,pw_hash) VALUES(?,?,?,?)", (a[1], "Teacher", "teacher", D.hash_pw(a[2])))
            print("teacher created")
        elif a[0] == "reset-password":
            c.execute("UPDATE users SET pw_hash=? WHERE username=?", (D.hash_pw(a[2]), a[1])); print("password reset")
        elif a[0] == "set-daily-new":
            n = int(a[1])
            if not 0 <= n <= 1000: raise SystemExit("N must be between 0 and 1000")
            q, args = "UPDATE users SET daily_new=? WHERE role='student'", [n]
            if len(a) > 2: q += " AND username=?"; args.append(a[2])
            print(c.execute(q, args).rowcount, "student(s) updated")
        else:
            print(__doc__)

if __name__ == "__main__":
    main(sys.argv[1:] if len(sys.argv) > 1 else ["help"])