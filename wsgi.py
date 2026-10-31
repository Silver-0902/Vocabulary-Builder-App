"""WSGI entry point for hosts without ASGI support (e.g. PythonAnywhere free plan).

Point the web app's WSGI configuration file at this module:
    from wsgi import application
"""
import os, sys, threading

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# PythonAnywhere serves over HTTPS, so mark the session cookie Secure.
os.environ.setdefault("VOCAB_HTTPS", "1")

from app.main import app, _startup

_startup()  # a2wsgi does not run ASGI lifespan events, so init the DB here

# a2wsgi starts a background thread when it is created. Under uWSGI a thread
# started at import time may never run in the worker, so create it on the
# first request instead.
_lock = threading.Lock()
_wrapped = None

def application(environ, start_response):
    global _wrapped
    if _wrapped is None:
        with _lock:
            if _wrapped is None:
                from a2wsgi import ASGIMiddleware
                _wrapped = ASGIMiddleware(app)
    return _wrapped(environ, start_response)