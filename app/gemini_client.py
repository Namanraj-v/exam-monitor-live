import asyncio
import json
import os
import time
import httpx

DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"
REQUEST_BUDGET = 35
cached = ("", 0.0)


async def generate(prompt, grounding=False):
    key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    result = dict(
        ok=False,
        provider="gemini",
        model_used=None,
        status_code=None,
        error="API key unavailable",
    )
    if not key:
        return result
    env_model = os.getenv("GEMINI_MODEL", "").strip()
    models = [
        *( [env_model] if env_model else [] ),
        DEFAULT_GEMINI_MODEL,
        "gemini-2.5-flash-lite",
        "gemini-2.0-flash",
    ]
    if cached[1] > time.monotonic():
        models.insert(0, cached[0])
    payload = {"contents": [{"parts": [{"text": prompt}]}]}
    if grounding:
        payload["tools"] = [{"google_search": {}}]
    else:
        payload["generationConfig"] = {
            "responseMimeType": "application/json",
            "temperature": 0.1,
        }

    async def request_models():
        global cached
        retry = True
        async with httpx.AsyncClient(timeout=httpx.Timeout(12, connect=4)) as client:
            for model in dict.fromkeys(models):
                result["model_used"] = model
                while True:
                    try:
                        r = await client.post(
                            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                            headers={"x-goog-api-key": key},
                            json=payload,
                        )
                        result["status_code"] = r.status_code
                        r.raise_for_status()
                        candidate = r.json()["candidates"][0]
                        raw = "".join(
                            p.get("text", "") for p in candidate["content"]["parts"]
                        )
                        answer = json.loads(
                            raw.strip()
                            .removeprefix("```json")
                            .removesuffix("```")
                            .strip()
                        )
                        if not isinstance(answer, dict):
                            raise ValueError("Expected JSON object")
                        chunks = candidate.get("groundingMetadata", {}).get(
                            "groundingChunks", []
                        )
                        cached = (model, time.monotonic() + 3600)
                        return dict(
                            result,
                            ok=True,
                            error=None,
                            data=answer,
                            sources=[
                                c["web"]["uri"]
                                for c in chunks
                                if c.get("web", {}).get("uri")
                            ],
                        )
                    except (httpx.HTTPError, ValueError, KeyError, IndexError) as exc:
                        result["error"] = type(exc).__name__
                        if retry and (
                            isinstance(exc, httpx.TimeoutException)
                            or result["status_code"] in {429, 503}
                        ):
                            retry = False
                            await asyncio.sleep(0.6)
                            continue
                        break
        return result

    try:
        return await asyncio.wait_for(request_models(), timeout=REQUEST_BUDGET)
    except asyncio.TimeoutError:
        result["error"] = "Request budget exceeded"
    return result
