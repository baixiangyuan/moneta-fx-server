# syntax=docker/dockerfile:1
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    MONETA_HOST=0.0.0.0 \
    MONETA_PORT=4173 \
    MONETA_DATA_DIR=/data

WORKDIR /app

COPY moneta_fx ./moneta_fx
COPY server ./server

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic

EXPOSE 4173
VOLUME ["/data"]

CMD ["python", "server/app.py"]
