#!/bin/sh
# Fresh database + server, then the browser test. Usage: sh tests/run_e2e.sh
cd "$(dirname "$0")/.."
[ -f /tmp/uv.pid ] && kill "$(cat /tmp/uv.pid)" 2>/dev/null; sleep 1
rm -f /tmp/e2e.db*
VOCAB_DB=/tmp/e2e.db TEACHER_USERNAME=teacher TEACHER_PASSWORD=teachpass1 python3 -m uvicorn app.main:app --port 8765 >/tmp/uv.log 2>&1 &
echo $! > /tmp/uv.pid
sleep 3
node tests/e2e.js; rc=$?
kill "$(cat /tmp/uv.pid)" 2>/dev/null
exit $rc
