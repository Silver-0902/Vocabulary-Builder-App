"""WSGI entry point for hosts without ASGI support (e.g. PythonAnywhere free plan).

Point the web app's WSGI configuration file at this module:
    from wsgi import application
"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# PythonAnywhere serves over HTTPS, so mark the session cookie Secure.
os.environ.setdefault("VOCAB_HTTPS", "1")

from a2wsgi import ASGIMiddleware
from app.main import app, _startup

_startup()  # a2wsgi does not run ASGI lifespan events, so init the DB here
application = ASGIMiddleware(app)s