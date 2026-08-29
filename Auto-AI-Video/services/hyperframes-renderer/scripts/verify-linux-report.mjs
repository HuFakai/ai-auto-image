import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { platform } from "node:os";

const serviceRoot = resolve(import.meta.dirname, "..");
const resultsRoot = join(serviceRoot, "benchmark-results");

if (platform() !== "linux") {
  throw new Error(`Linux verification must run on Linux, received ${platform()}`);
}

const browserPath = process.env.HYPERFRAMES_BROWSER_PATH || "";
if (!browserPath || !existsSync(browserPath)) {
  throw new Error("HYPERFRAMES_BROWSER_PATH must point to the managed browser executable");
}
if (!/chrome-headless-shell/i.test(browserPath)) {
  throw new Error(`Expected chrome-headless-shell, received ${basename(browserPath)}`);
}

const reports = (await readdir(resultsRoot))
  .filter((name) => /^benchmark-\d+\.json$/.test(name))
  .map((name) => join(resultsRoot, name));
if (!reports.length) throw new Error("No HyperFrames benchmark report was produced");

const newest = (
  await Promise.all(reports.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })))
).sort((left, right) => right.modified - left.modified)[0].path;
const report = JSON.parse(await readFile(newest, "utf8"));
const runs = Array.isArray(report.runs) ? report.runs : [];

if (report.hyperframes_version !== "0.8.4") {
  throw new Error(`Unexpected HyperFrames version: ${report.hyperframes_version}`);
}
if (report.machine?.platform !== "linux") {
  throw new Error(`Benchmark report platform is not Linux: ${report.machine?.platform}`);
}
if (report.run_count !== 20 || runs.length !== 20) {
  throw new Error(`Expected 20 successful renders, received ${runs.length}`);
}
if (report.summary?.browser_worker_delta !== 0) {
  throw new Error(`Browser worker leak detected: ${report.summary?.browser_worker_delta}`);
}

for (const run of runs) {
  if (Math.abs(Number(run.duration_seconds) - 8) > 0.1) {
    throw new Error(`Run ${run.index} duration drifted to ${run.duration_seconds}s`);
  }
  if (Number(run.output_bytes) <= 0 || !existsSync(run.output)) {
    throw new Error(`Run ${run.index} did not produce a non-empty output`);
  }
  if (run.browser_workers_after !== 0) {
    throw new Error(`Run ${run.index} left ${run.browser_workers_after} browser workers`);
  }
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  report: newest,
  browser: browserPath,
  runs: runs.length,
  average_seconds: report.summary.average_seconds,
  p95_seconds: report.summary.p95_seconds,
  peak_rss_mb: report.summary.peak_rss_mb,
}, null, 2)}\n`);
