import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / "backend" / ".env")

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
MODEL_EXTRACT = os.getenv("MODEL_EXTRACT", "deepseek/deepseek-v4.1-flash")
MODEL_CONSOLIDATE = os.getenv("MODEL_CONSOLIDATE", "deepseek/deepseek-v4.1-flash")
MODEL_CHAT = os.getenv("MODEL_CHAT", MODEL_CONSOLIDATE)
FRAGE_VOLLTEXT_MAX = int(os.getenv("FRAGE_VOLLTEXT_MAX", "60000"))
FRAGE_EFFORT = os.getenv("FRAGE_EFFORT", "low")
CONCURRENCY = int(os.getenv("CONCURRENCY", "5"))
CASES_DIR = ROOT / "cases"
