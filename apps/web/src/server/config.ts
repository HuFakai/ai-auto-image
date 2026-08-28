/** Server-side runtime config with safe defaults. */

export interface ConcurrencyConfig {
  defaultRequested: number;
  serverMax: number;
  postprocessMax: number;
}

export function concurrencyConfig(): ConcurrencyConfig {
  return {
    defaultRequested: intEnv("IMAGE_GENERATION_CONCURRENCY_DEFAULT", 1),
    serverMax: intEnv("IMAGE_GENERATION_CONCURRENCY_MAX", 4),
    postprocessMax: intEnv("IMAGE_POSTPROCESS_CONCURRENCY_MAX", 1),
  };
}

export function resolveEffectiveConcurrency(requested: number, providerMax?: number) {
  const cfg = concurrencyConfig();
  const req = Math.max(1, Math.round(requested) || cfg.defaultRequested);
  const effective = Math.min(req, cfg.serverMax, providerMax ?? Number.MAX_SAFE_INTEGER);
  return { requested: req, serverMax: cfg.serverMax, providerMax, effective, postprocessMax: cfg.postprocessMax };
}

function intEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PROMPT_VERSION = "2026-08-28.1";

/** Rough per-call cost book (CNY cents) for pre-run estimation only. */
export const COST_ESTIMATE = {
  textCallCents: 2,
  imageCallCents: 40,
};
