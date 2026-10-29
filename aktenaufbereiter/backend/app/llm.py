"""OpenRouter-Client (OpenAI-kompatibel): JSON-Ausgabe gegen ein Pydantic-Schema, optional mit Bildern."""
from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
from pathlib import Path
from typing import TypeVar

import json_repair
from openai import APIStatusError, AsyncOpenAI
from pydantic import BaseModel, ValidationError

from . import config

T = TypeVar("T", bound=BaseModel)
_client: AsyncOpenAI | None = None


def client() -> AsyncOpenAI:
    global _client
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY fehlt (backend/.env).")
    if _client is None:
        _client = AsyncOpenAI(api_key=config.OPENROUTER_API_KEY, base_url=config.OPENROUTER_BASE_URL)
    return _client


def _image_part(path: Path) -> dict:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    b64 = base64.b64encode(path.read_bytes()).decode()
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}}


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    s, e = text.find("{"), text.rfind("}")
    return text[s : e + 1] if s != -1 else text


async def _create(model: str, messages: list, max_tokens: int):
    for attempt in range(4):
        try:
            return await client().chat.completions.create(
                model=model, messages=messages, max_tokens=max_tokens, temperature=0,
                response_format={"type": "json_object"}, extra_body={"reasoning": {"exclude": True}},
            )
        except APIStatusError as e:
            if e.status_code == 404 and "guardrail" in str(e).lower():
                raise RuntimeError(f"Modell {model} ist in den OpenRouter-Guardrails gesperrt. "
                                   "Erlaubtes Modell in backend/.env eintragen.") from e
            if e.status_code == 429 or e.status_code >= 500:
                if attempt < 3:
                    await asyncio.sleep(2 * 2**attempt)
                    continue
            raise


async def ask(model: str, system: str, user: str, schema: type[T], images: list[Path] | None = None,
              retries: int = 2, max_tokens: int = 16000) -> T:
    content: list[dict] = [{"type": "text", "text": user}]
    content += [_image_part(p) for p in images or []]
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    last: Exception | None = None
    for _ in range(retries + 1):
        resp = await _create(model, messages, max_tokens)
        raw = _extract_json(resp.choices[0].message.content or "")
        try:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                data = json_repair.loads(raw)  # kleine Syntaxfehler (fehlende Kommas o. ä.) reparieren
            return schema.model_validate(data)
        except (ValueError, ValidationError) as e:
            last = e
            # neu fragen, ohne die (evtl. sehr lange) fehlerhafte Antwort mitzuschicken
            messages = messages[:2] + [{"role": "user", "content": f"Hinweis: Der vorige Versuch war ungültig ({str(e)[:400]}). "
                                        "Gib ausschließlich korrektes JSON nach dem Schema aus."}]
    raise RuntimeError(f"Modellausgabe nicht validierbar: {last}")
