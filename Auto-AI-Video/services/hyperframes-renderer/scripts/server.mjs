import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { cpus, platform } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { serve } from "@hono/node-server";
import { createRenderJob, executeRenderJob } from "@hyperframes/producer";
import { Hono } from "hono";

const serviceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(serviceRoot, "../..");
const runtimeRoot = resolve(process.env.HYPERFRAMES_RUNTIME_DIR || resolve(serviceRoot, "runtime"));
const statePath = resolve(runtimeRoot, "render-jobs.json");
const outputsRoot = resolve(runtimeRoot, "outputs");
const allowedRoot = resolve(process.env.HYPERFRAMES_PROJECTS_ROOT || repositoryRoot);
const isWindows = platform() === "win32";
// HyperFrames reads HYPERFRAMES_BROWSER_PATH itself.  Merely reporting a
// discovered system browser from /ready is not enough: child check processes
// and the in-process producer otherwise fall back to the managed cache, which
// can contain an incompatible Windows binary (0xc000007b).
const browserPath = resolveBrowserPath();
if (browserPath) process.env.HYPERFRAMES_BROWSER_PATH = browserPath;
if (isWindows && !process.env.PRODUCER_BROWSER_GPU_MODE) {
  // `auto` probes WebGL first and safely falls back to software.  On supported
  // Windows GPUs this unlocks streaming capture, sharply reducing temporary
  // PNG disk usage compared with forced software screenshot capture.
  process.env.PRODUCER_BROWSER_GPU_MODE = "auto";
}

// Each render can launch multiple browser/FFmpeg workers.  Unlimited jobs are
// particularly counterproductive on a Windows desktop, where they compete for
// GPU memory and make every job slower.  Other platforms retain the existing
// unlimited default; an explicit environment value always wins.
const defaultMaxConcurrent = isWindows ? 1 : Infinity;
const maxConcurrent = parseConcurrency(
  process.env.HYPERFRAMES_MAX_CONCURRENT,
  defaultMaxConcurrent,
);
const jobs = new Map();
const controllers = new Map();
const lastProgressPersist = new Map();
const queue = [];
const checkerVersion = "0.8.4";
let active = 0;
let persistTail = Promise.resolve();

await mkdir(outputsRoot, { recursive: true });
await loadState();

const app = new Hono();

app.get("/ready", (context) => {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
  const checks = {
    node: { ok: nodeMajor >= 22, version: process.versions.node },
    ffmpeg: { ok: ffmpeg.status === 0 },
    browser: { ok: Boolean(browserPath), path: browserPath || null },
    runtime: { ok: existsSync(runtimeRoot), path: runtimeRoot },
    producer: { ok: true, version: checkerVersion },
  };
  const ready = Object.values(checks).every((check) => check.ok);
  return context.json({
    ready,
    checks,
    queue: queue.length,
    active,
    max_concurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : null,
    unlimited_concurrency: !Number.isFinite(maxConcurrent),
    default_workers: isWindows ? 1 : Math.min(2, cpus().length),
    browser_gpu_mode: process.env.PRODUCER_BROWSER_GPU_MODE || "software",
  }, ready ? 200 : 503);
});

app.get("/renders", (context) => context.json({ renders: [...jobs.values()].map(publicJob) }));

app.post("/renders", async (context) => {
  let body;
  try {
    body = await context.req.json();
  } catch {
    return context.json({ error: "Request body must be valid JSON" }, 400);
  }
  const validation = validateRenderRequest(body);
  if (validation.error) return context.json({ error: validation.error }, 422);

  const id = randomUUID();
  const outputPath = validation.value.output_path || resolve(outputsRoot, `${id}.mp4`);
  if (!isInside(allowedRoot, outputPath) && !isInside(runtimeRoot, outputPath)) {
    return context.json({ error: "output_path must stay inside the project or renderer runtime root" }, 422);
  }
  const now = new Date().toISOString();
  const job = {
    id,
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "等待 HyperFrames 渲染资源",
    project_dir: validation.value.project_dir,
    output_path: outputPath,
    options: validation.value.options,
    created_at: now,
    updated_at: now,
    error: null,
    failed_stage: null,
    result: null,
  };
  jobs.set(id, job);
  queue.push(id);
  await persistState();
  pump();
  return context.json(publicJob(job), 202);
});

app.get("/renders/:id", (context) => {
  const job = jobs.get(context.req.param("id"));
  return job ? context.json(publicJob(job)) : context.json({ error: "Render not found" }, 404);
});

app.post("/renders/:id/cancel", async (context) => {
  const id = context.req.param("id");
  const job = jobs.get(id);
  if (!job) return context.json({ error: "Render not found" }, 404);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return context.json(publicJob(job), 409);
  }
  const queuedIndex = queue.indexOf(id);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  controllers.get(id)?.abort("user_cancelled");
  updateJob(job, {
    status: "cancelled",
    stage: "cancelled",
    message: "渲染已取消",
  });
  await persistState();
  return context.json(publicJob(job));
});

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: "Renderer service internal error" }, 500);
});

function pump() {
  while (active < maxConcurrent && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    active += 1;
    void runJob(job).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function runJob(job) {
  const controller = new AbortController();
  controllers.set(job.id, controller);
  await mkdir(dirname(job.output_path), { recursive: true });
  updateJob(job, { status: "running", stage: "preprocessing", progress: 1, message: "正在检查并编译项目" });
  await persistState();
  const producerJob = createRenderJob({
    fps: job.options.fps,
    quality: job.options.quality,
    format: "mp4",
    strictness: job.options.strictness,
    workers: job.options.workers,
    useGpu: job.options.use_gpu,
    entryFile: job.options.entry_file,
    hdrMode: "force-sdr",
  });
  try {
    updateJob(job, { status: "running", stage: "check", progress: 3, message: "正在执行 HyperFrames 项目检查" });
    await persistState();
    const checkReport = await runProjectCheck(job.project_dir, job.options.strictness, controller.signal);
    updateJob(job, { status: "running", stage: "checked", progress: 8, message: "项目检查通过，准备逐帧渲染" });
    await persistState();
    await executeRenderJob(
      producerJob,
      job.project_dir,
      job.output_path,
      async (progress, message) => {
        if (job.status === "cancelled") return;
        const previousStage = job.stage;
        const rawProgress = Number(progress.progress);
        const percentage = Number.isFinite(rawProgress)
          ? (rawProgress <= 1 ? rawProgress * 100 : rawProgress)
          : job.progress;
        updateJob(job, {
          status: "running",
          stage: progress.currentStage || progress.status || "rendering",
          progress: Math.max(job.progress, Math.min(99, Math.round(percentage))),
          message: message || progress.currentStage || "正在渲染",
        });
        const now = Date.now();
        if (job.stage !== previousStage || now - (lastProgressPersist.get(job.id) || 0) >= 1000) {
          lastProgressPersist.set(job.id, now);
          await persistState();
        }
      },
      controller.signal,
    );
    if (job.status === "cancelled") return;
    const output = await stat(job.output_path);
    updateJob(job, {
      status: "completed",
      stage: "complete",
      progress: 100,
      message: "HyperFrames 渲染完成",
      completed_at: new Date().toISOString(),
      result: {
        output_path: job.output_path,
        size_bytes: output.size,
        duration: producerJob.duration || null,
        total_frames: producerJob.totalFrames || null,
        warnings: producerJob.warnings || [],
        perf_summary: producerJob.perfSummary || null,
        check_report_path: checkReport.path,
      },
    });
  } catch (error) {
    if (controller.signal.aborted || job.status === "cancelled") {
      updateJob(job, { status: "cancelled", stage: "cancelled", message: "渲染已取消" });
    } else {
      updateJob(job, {
        status: "failed",
        stage: error?.stage || producerJob.failedStage || producerJob.currentStage || "unknown",
        message: "HyperFrames 渲染失败",
        error: error instanceof Error ? error.message : String(error),
        failed_stage: error?.stage || producerJob.failedStage || producerJob.currentStage || "unknown",
        completed_at: new Date().toISOString(),
      });
    }
  } finally {
    controllers.delete(job.id);
    lastProgressPersist.delete(job.id);
    await persistState();
  }
}

async function runProjectCheck(projectDir, strictness, signal) {
  const reportPath = resolve(projectDir, "check-report.json");
  const projectFingerprint = await checkFingerprint(projectDir);
  if (existsSync(reportPath)) {
    try {
      const cached = JSON.parse(await readFile(reportPath, "utf8"));
      if (
        cached.ok === true
        && cached._pixelle?.project_fingerprint === projectFingerprint
        && cached._pixelle?.strictness === strictness
        && cached._pixelle?.checker_version === checkerVersion
      ) {
        return { path: reportPath, report: cached, cached: true };
      }
    } catch {
      // A corrupt or legacy report is not reusable; run a fresh check below.
    }
  }
  const cli = resolve(serviceRoot, "node_modules/hyperframes/bin/hyperframes.mjs");
  const args = [cli, "check", projectDir, "--json", "--timeout", "30000"];
  if (strictness === "strict") args.push("--strict");
  const outcome = await new Promise((resolveOutcome, rejectOutcome) => {
    const child = spawn(process.execPath, args, {
      cwd: serviceRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => `${current}${chunk}`.slice(-2_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const abort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", rejectOutcome);
    child.once("close", (code, childSignal) => {
      signal.removeEventListener("abort", abort);
      resolveOutcome({ code, signal: childSignal, stdout, stderr });
    });
  });
  let payload;
  try {
    payload = JSON.parse(outcome.stdout);
  } catch {
    payload = {
      ok: false,
      exit_code: outcome.code,
      error: "HyperFrames check did not return valid JSON",
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  }
  payload._pixelle = {
    project_fingerprint: projectFingerprint,
    strictness,
    checker_version: checkerVersion,
    checked_at: new Date().toISOString(),
  };
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  if (signal.aborted) {
    const error = new Error("HyperFrames project check cancelled");
    error.stage = "check";
    throw error;
  }
  if (outcome.code !== 0 || payload.ok === false) {
    const detail = summarizeCheckFailure(payload, outcome.stderr);
    const error = new Error(`HyperFrames check failed: ${detail}`);
    error.stage = "check";
    throw error;
  }
  return { path: reportPath, report: payload };
}

async function checkFingerprint(projectDir) {
  const digest = createHash("sha256");
  for (const filename of ["index.html", "manifest.json", "hyperframes.json"]) {
    const path = resolve(projectDir, filename);
    digest.update(filename);
    digest.update(existsSync(path) ? await readFile(path) : Buffer.from("missing"));
  }
  return digest.digest("hex");
}

function summarizeCheckFailure(payload, stderr) {
  const sections = ["lint", "runtime", "layout", "motion", "contrast"];
  const findings = sections.flatMap((section) =>
    Array.isArray(payload?.[section]?.findings) ? payload[section].findings : []
  );
  const relevant = findings.filter((finding) =>
    finding?.severity === "error" || (payload?.ok === false && finding?.severity === "warning")
  );
  if (relevant.length) {
    return relevant
      .slice(0, 4)
      .map((finding) => `${finding.code || finding.severity}: ${finding.message || "check finding"}`)
      .join("; ");
  }
  return payload?.error || payload?.message || stderr.trim() || "project check failed";
}

function validateRenderRequest(body) {
  if (!body || typeof body !== "object") return { error: "Request body must be an object" };
  const rawProjectDir = typeof body.project_dir === "string" ? body.project_dir : "";
  const projectDir = rawProjectDir ? resolve(rawProjectDir) : "";
  if (!rawProjectDir || !isAbsolute(rawProjectDir) || !isInside(allowedRoot, projectDir)) {
    return { error: "project_dir must be an absolute path inside HYPERFRAMES_PROJECTS_ROOT" };
  }
  const entryFile = typeof body.entry_file === "string" ? body.entry_file : "index.html";
  if (entryFile.includes("..") || isAbsolute(entryFile)) return { error: "entry_file must be project-relative" };
  if (!existsSync(resolve(projectDir, entryFile))) return { error: `Composition entry does not exist: ${entryFile}` };
  const fps = Number(body.fps ?? 30);
  if (![24, 30, 60].includes(fps)) return { error: "fps must be 24, 30, or 60" };
  const quality = body.quality ?? "standard";
  if (!["draft", "standard", "high"].includes(quality)) return { error: "quality is invalid" };
  const strictness = body.strictness ?? "strict";
  if (!["strict", "best-effort"].includes(strictness)) return { error: "strictness is invalid" };
  const workers = boundedInteger(body.workers, isWindows ? 1 : Math.min(2, cpus().length), 1, 8);
  if (typeof body.output_path === "string" && !isAbsolute(body.output_path)) {
    return { error: "output_path must be absolute when supplied" };
  }
  const outputPath = typeof body.output_path === "string" ? resolve(body.output_path) : null;
  return {
    value: {
      project_dir: projectDir,
      output_path: outputPath,
      options: { fps, quality, strictness, workers, use_gpu: body.use_gpu !== false, entry_file: entryFile },
    },
  };
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    message: job.message,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at || null,
    error: job.error,
    failed_stage: job.failed_stage,
    result: job.result,
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updated_at: new Date().toISOString() });
}

async function loadState() {
  if (!existsSync(statePath)) return;
  try {
    const values = JSON.parse(await readFile(statePath, "utf8"));
    for (const value of Array.isArray(values) ? values : []) {
      if (["queued", "running"].includes(value.status)) {
        updateJob(value, {
          status: "failed",
          stage: "service_restart",
          message: "渲染服务重启，任务可安全重试",
          error: "Renderer service restarted before the render completed",
          failed_stage: "service_restart",
          completed_at: new Date().toISOString(),
        });
      }
      jobs.set(value.id, value);
    }
    await persistState();
  } catch (error) {
    console.error(`Unable to load renderer state: ${error}`);
  }
}

function persistState() {
  // Capture the state at enqueue time.  A render can emit progress from more
  // than one producer callback, so state writes must be serialized.
  const snapshot = `${JSON.stringify([...jobs.values()], null, 2)}\n`;
  const writeSnapshot = async () => {
    await mkdir(dirname(statePath), { recursive: true });
    // A fixed .tmp filename lets two renderer processes clobber one another.
    // It also makes a stale temporary file from a terminated Windows process
    // block every later progress update.  Keep each attempted replacement
    // private to this process instead.
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, snapshot, "utf8");
      await replaceStateFile(temporary, snapshot);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  };

  // Once a promise in this chain rejects, `.then()` alone would leave every
  // later state update permanently rejected.  Persistence must never take a
  // successful video render down with it; the live job state remains in memory
  // and the next update will retry the durable snapshot.
  persistTail = persistTail
    .catch((error) => console.warn(`Previous renderer state write failed: ${error}`))
    .then(writeSnapshot)
    .catch((error) => console.warn(`Unable to persist renderer state: ${error}`));
  return persistTail;
}

async function replaceStateFile(temporary, snapshot) {
  // On Windows, Defender, an indexer, or a stale file viewer can briefly hold
  // the destination open without delete sharing.  Retry the atomic rename,
  // then fall back to an in-place write (which does not require delete access)
  // so this bookkeeping failure can never terminate the renderer.
  const attempts = isWindows ? 12 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(temporary, statePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isWindows || !isTransientWindowsFileError(error) || attempt === attempts - 1) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * (attempt + 1)));
    }
  }
  if (isWindows && isTransientWindowsFileError(lastError)) {
    console.warn(`Atomic renderer state replacement blocked; updating in place: ${lastError}`);
    await writeFile(statePath, snapshot, "utf8");
    return;
  }
  throw lastError;
}

function isTransientWindowsFileError(error) {
  return ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function parseConcurrency(value, fallback = Infinity) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveBrowserPath() {
  const configured = process.env.HYPERFRAMES_BROWSER_PATH;
  if (configured) return existsSync(configured) ? configured : "";
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    // Windows: Chrome / Edge installation locations.
    process.env.ProgramFiles
      ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`
      : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    process.env["ProgramFiles(x86)"]
      ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`
      : "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : undefined,
    process.env.ProgramFiles
      ? `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
      : "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    process.env["ProgramFiles(x86)"]
      ? `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`
      : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

const port = boundedInteger(process.env.HYPERFRAMES_RENDERER_PORT, 8788, 1, 65535);
const hostname = process.env.HYPERFRAMES_RENDERER_HOST || "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Pixelle HyperFrames Renderer listening on http://${info.address}:${info.port}`);
});
