# Pixelle Production Desk

Next.js 16 production dashboard for continuous short-video operations.

```bash
cp .env.example .env.local
npm install
npm run dev
```

The default frontend URL is `http://127.0.0.1:13123`. Set `PIXELLE_API_URL`
to the FastAPI origin; it defaults to `http://127.0.0.1:18123`.

The desk includes live channel inventory, editable channels, content sources,
semantic topic deduplication, title experiments, storyboard/revision review,
quality gates, and an approval-gated AI producer. The producer can inspect the
same SQLite ledger as `scripts/run_production.py`, but every write remains a
persisted plan until the operator explicitly approves it.
