import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { cpus, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(serviceRoot, "fixtures", "stickman-psychology");
const resultsDir = join(serviceRoot, "benchmark-results");
const runtimeEnv = { ...process.env };
const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!runtimeEnv.HYPERFRAMES_BROWSER_PATH && platform() === "darwin" && existsSync(macChrome)) {
  runtimeEnv.HYPERFRAMES_BROWSER_PATH = macChrome;
}
runtimeEnv.HYPERFRAMES_RUN_ID ??= `pixelle-f0-${Date.now()}`;

function parseRuns() {
  const index = process.argv.indexOf("--runs");
  const value = index >= 0 ? Number(process.argv[index + 1]) : 1;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("--runs must be an integer between 1 and 100");
  }
  return value;
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveRun({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function processTreeRssKb(rootPid) {
  if (platform() === "win32") return null;
  const result = await run("ps", ["-axo", "pid=,ppid=,rss="], fixture);
  const rows = result.stdout.trim().split("\n").map((line) => {
    const [pid, ppid, rss] = line.trim().split(/\s+/).map(Number);
    return { pid, ppid, rss };
  });
  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (tree.has(row.ppid) && !tree.has(row.pid)) {
        tree.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => tree.has(row.pid)).reduce((sum, row) => sum + row.rss, 0);
}

async function browserWorkerCount() {
  if (platform() === "win32") return null;
  const result = await run("ps", ["-axo", "command="], fixture);
  return result.stdout
    .split("\n")
    .filter((line) => /puppeteer_dev_chrome_profile|chrome-headless-shell/.test(line))
    .length;
}

function runMeasured(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const started = performance.now();
    let stdout = "";
    let stderr = "";
    let peakRssKb = 0;
    let sampling = false;
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const rss = await processTreeRssKb(child.pid);
        if (rss !== null) peakRssKb = Math.max(peakRssKb, rss);
      } finally {
        sampling = false;
      }
    };
    const timer = setInterval(sample, 250);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearInterval(timer);
      await sample();
      const elapsedSeconds = (performance.now() - started) / 1000;
      if (code === 0) {
        resolveRun({ stdout, stderr, elapsedSeconds, peakRssKb });
      } else {
        reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
      }
    });
  });
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(Math.ceil(sorted.length * ratio) - 1, sorted.length - 1)];
}

const runCount = parseRuns();
await mkdir(resultsDir, { recursive: true });
const browserWorkersBefore = await browserWorkerCount();
const checkStarted = performance.now();
await run("npm", ["run", "check"], fixture);
const checkSeconds = (performance.now() - checkStarted) / 1000;
const runs = [];

for (let index = 0; index < runCount; index += 1) {
  const suffix = runCount === 1 ? "" : `-${String(index + 1).padStart(2, "0")}`;
  const output = join(resultsDir, `stickman-psychology-draft${suffix}.mp4`);
  const measured = await runMeasured(
    "npx",
    ["--yes", "hyperframes@0.8.4", "render", "--quality", "draft", "--output", output],
    fixture,
  );
  const probeResult = await run(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration,size",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate",
      "-of", "json",
      output,
    ],
    fixture,
  );
  const probe = JSON.parse(probeResult.stdout);
  const outputStat = await stat(output);
  const duration = Number(probe.format?.duration ?? 0);
  const video = probe.streams?.find((stream) => stream.codec_name === "h264");
  if (
    outputStat.size <= 0
    || Math.abs(duration - 8) > 0.1
    || video?.width !== 1080
    || video?.height !== 1920
    || video?.r_frame_rate !== "30/1"
  ) {
    throw new Error(`Run ${index + 1} failed output validation`);
  }
  const browserWorkersAfterRun = await browserWorkerCount();
  const entry = {
    index: index + 1,
    elapsed_seconds: Number(measured.elapsedSeconds.toFixed(3)),
    peak_rss_mb: Number((measured.peakRssKb / 1024).toFixed(1)),
    output_bytes: outputStat.size,
    duration_seconds: duration,
    browser_workers_after: browserWorkersAfterRun,
    output,
  };
  runs.push(entry);
  process.stdout.write(
    `[${index + 1}/${runCount}] ${entry.elapsed_seconds}s, ${entry.peak_rss_mb} MB peak, `
    + `${entry.output_bytes} bytes, ${entry.browser_workers_after} browser workers remain\n`,
  );
}

const elapsedValues = runs.map((entry) => entry.elapsed_seconds);
const peakValues = runs.map((entry) => entry.peak_rss_mb);
const browserWorkersAfter = await browserWorkerCount();
const result = {
  hyperframes_version: "0.8.4",
  fixture: "stickman-psychology",
  created_at: new Date().toISOString(),
  machine: { hostname: hostname(), platform: platform(), release: release(), cpus: cpus().length },
  browser_path: runtimeEnv.HYPERFRAMES_BROWSER_PATH ?? "hyperframes-managed",
  check_seconds: Number(checkSeconds.toFixed(3)),
  run_count: runCount,
  summary: {
    average_seconds: Number((elapsedValues.reduce((sum, value) => sum + value, 0) / runCount).toFixed(3)),
    p95_seconds: Number(percentile(elapsedValues, 0.95).toFixed(3)),
    peak_rss_mb: Math.max(...peakValues),
    browser_workers_before: browserWorkersBefore,
    browser_workers_after: browserWorkersAfter,
    browser_worker_delta: (
      browserWorkersBefore === null || browserWorkersAfter === null
        ? null
        : browserWorkersAfter - browserWorkersBefore
    ),
  },
  runs,
};
const resultPath = join(resultsDir, `benchmark-${Date.now()}.json`);
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...result, result_path: resultPath }, null, 2)}\n`);
