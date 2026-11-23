"""Windows desktop entry point. Cloud deployments use server.py."""

import os
import webbrowser

import uvicorn
from dotenv import load_dotenv

from app.database import ROOT


class LocalServer(uvicorn.Server):
    async def startup(self, sockets=None):
        await super().startup(sockets)
        if self.started:
            url = f"http://127.0.0.1:{self.config.port}/"
            print(f"Open Exam Monitor here: {url}", flush=True)
            webbrowser.open(url)


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    config = uvicorn.Config(
        "app.main:app",
        host="127.0.0.1",
        port=int(os.getenv("PORT", "7860")),
        workers=1,
        proxy_headers=False,
    )
    server = LocalServer(config)
    server.run()
    if not server.started:
        raise SystemExit(1)
