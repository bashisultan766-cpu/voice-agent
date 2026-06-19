#!/bin/bash
# Quick local setup for the Python backend
set -e

echo "==> Creating virtual environment..."
python -m venv venv

echo "==> Installing dependencies..."
./venv/Scripts/pip install -r requirements.txt 2>/dev/null || venv/bin/pip install -r requirements.txt

echo "==> Copying env file..."
[ -f .env ] || cp .env.example .env

echo ""
echo "Done. Next steps:"
echo "  1. Edit .env with your real credentials"
echo "  2. Start postgres + redis (docker compose up -d db redis)"
echo "  3. Run migrations: venv/Scripts/alembic upgrade head"
echo "  4. Start server: venv/Scripts/uvicorn app.main:app --reload --port 8000"
