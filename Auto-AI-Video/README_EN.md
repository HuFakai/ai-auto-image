# Pixelle Video · Grok Continuous Production Desk

This fork is a Grok-first short-video production system. It uses an OpenAI-compatible LLM endpoint, `grok-imagine-image-quality`, `grok-imagine-video`, Edge TTS, FFmpeg composition, durable FastAPI tasks, and an inventory-driven SQLite runner.

ComfyUI, RunningHub, digital-human, and motion-transfer runtimes have been removed.

## Start

```bash
uv sync --extra dev
cp config.example.yaml config.yaml
uv run python api/app.py --host 127.0.0.1 --port 18123
```

The continuous production runner is owned by the API process. Start or stop it
with the switch in the Production Desk header; no separate runner terminal is
required.

Start the new production desk:

```bash
cd studio
cp .env.example .env.local
npm install
npm run dev
```

Open `http://127.0.0.1:13123`. Configure `PIXELLE_API_URL` when the FastAPI origin is not `http://127.0.0.1:18123`. The desk supports channel creation, copying and hot updates, pause/resume, one-off test videos, queue retry/cancel, SSE updates, review notes, approval gates, and publication marking.

See [Grok integration](docs/GROK2API.md), [production runner](docs/PRODUCTION_RUNNER.md), and the [upgrade roadmap](docs/roadmap/2026-08-12-studio-upgrade/README.md).
