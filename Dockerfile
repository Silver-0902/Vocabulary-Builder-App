FROM python:3.12-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
COPY static static
COPY data/seed_cards.json data/seed_cards.json
ENV VOCAB_DB=/data/vocab.db VOCAB_HTTPS=1
VOLUME /data
EXPOSE 8000
# one worker on purpose: the login rate-limiter lives in memory
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8000","--workers","1"]
