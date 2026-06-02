FROM node:20-slim AS frontend

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY input.css tailwind.config.js ./
COPY templates ./templates
COPY static ./static
RUN npm run build

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
COPY --from=frontend /app/static/output.css /app/static/output.css

RUN mkdir -p /app/data /app/uploads \
    && adduser --disabled-password --gecos "" appuser \
    && chown -R appuser:appuser /app/data /app/uploads

USER appuser

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
