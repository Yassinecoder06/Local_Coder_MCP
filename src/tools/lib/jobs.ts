import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface Job {
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string | null;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  child: ChildProcess | null;
  outputBuffer: string[];
  totalBytes: number;
  pendingOutputBuffer: string[];
  pendingOutputBytes: number;
  outputWaiters: Set<() => void>;
}

export interface JobSummary {
  id: string;
  command: string;
  cwd: string;
  started_at: string;
  finished_at: string | null;
  pid: number | null;
  running: boolean;
  exit_code: number | null;
  signal: string | null;
  output_bytes: number;
}

export interface RunResult {
  job_id: string;
  running: boolean;
  output: string;
  output_so_far?: string;
  exit_code: number | null;
  pid?: number | null;
}

const MAX_JOBS = 20;
const MAX_JOB_OUTPUT_BYTES = 200_000;

class JobManager {
  private jobs = new Map<string, Job>();

  private prune() {
    if (this.jobs.size <= MAX_JOBS) return;

    // Find oldest finished jobs
    const finishedJobs: Job[] = [];
    for (const job of this.jobs.values()) {
      if (!job.running) {
        finishedJobs.push(job);
      }
    }

    finishedJobs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

    while (this.jobs.size > MAX_JOBS && finishedJobs.length > 0) {
      const oldest = finishedJobs.shift();
      if (oldest) {
        this.jobs.delete(oldest.id);
      }
    }
  }

  async startJob(
    command: string,
    cwd: string,
    syncMs: number,
    timeoutMs: number = 120_000
  ): Promise<RunResult> {
    this.prune();

    const id = `job_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
    const startedAt = new Date().toISOString();

    const job: Job = {
      id,
      command,
      cwd,
      startedAt,
      finishedAt: null,
      pid: null,
      running: true,
      exitCode: null,
      signal: null,
      child: null,
      outputBuffer: [],
      totalBytes: 0,
      pendingOutputBuffer: [],
      pendingOutputBytes: 0,
      outputWaiters: new Set(),
    };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      NO_COLOR: "1",
    };

    const appendOutput = (chunk: Buffer | string) => {
      const str = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      job.outputBuffer.push(str);
      job.totalBytes += Buffer.byteLength(str, "utf-8");
      job.pendingOutputBuffer.push(str);
      job.pendingOutputBytes += Buffer.byteLength(str, "utf-8");

      // Trim buffer if too large
      while (job.totalBytes > MAX_JOB_OUTPUT_BYTES && job.outputBuffer.length > 1) {
        const removed = job.outputBuffer.shift()!;
        job.totalBytes -= Buffer.byteLength(removed, "utf-8");
      }

      while (job.pendingOutputBytes > MAX_JOB_OUTPUT_BYTES && job.pendingOutputBuffer.length > 1) {
        const removed = job.pendingOutputBuffer.shift()!;
        job.pendingOutputBytes -= Buffer.byteLength(removed, "utf-8");
      }
      for (const waiter of [...job.outputWaiters]) waiter();
    };

    const child = spawn("bash", ["-lc", command], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    job.child = child;
    job.pid = child.pid ?? null;
    this.jobs.set(id, job);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") appendOutput(`\nstdin error: ${err.message}\n`);
    });

    // Timeout timer to automatically terminate hanging processes
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (job.running) {
          this.stopJob(id, "SIGTERM");
          // Force kill after 5 seconds if still running
          setTimeout(() => {
            if (job.running) {
              this.stopJob(id, "SIGKILL");
            }
          }, 5_000).unref();
        }
      }, timeoutMs);
      timeoutTimer.unref();
    }

    const exitPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, sig) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        job.running = false;
        job.exitCode = code;
        job.signal = sig;
        job.finishedAt = new Date().toISOString();
        job.child = null;
        for (const waiter of [...job.outputWaiters]) waiter();
        resolve({ exitCode: code, signal: sig });
      });

      child.on("error", (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        appendOutput(`\nProcess error: ${err.message}\n`);
        job.running = false;
        job.exitCode = 1;
        job.finishedAt = new Date().toISOString();
        job.child = null;
        for (const waiter of [...job.outputWaiters]) waiter();
        resolve({ exitCode: 1, signal: null });
      });
    });

    // Check if finishes within syncMs
    const waitPromise = new Promise<{ timeout: true }>((resolve) => {
      setTimeout(() => resolve({ timeout: true }), Math.max(100, syncMs));
    });

    const race = await Promise.race([
      exitPromise.then((res) => ({ timeout: false, ...res })),
      waitPromise,
    ]);

    if (!race.timeout) {
      this.drainPendingOutput(job);
      return {
        job_id: id,
        running: false,
        output: job.outputBuffer.join(""),
        exit_code: job.exitCode,
      };
    }

    this.drainPendingOutput(job);
    return {
      job_id: id,
      running: true,
      output: job.outputBuffer.join(""),
      output_so_far: job.outputBuffer.join(""),
      exit_code: null,
      pid: job.pid,
    };
  }

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  writeJobStdin(id: string, input: string): boolean {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job "${id}" not found`);
    if (!job.running || !job.child?.stdin || job.child.stdin.destroyed || job.child.stdin.writableEnded) return false;
    job.child.stdin.write(input);
    return true;
  }

  async waitForNewOutput(id: string, waitMs = 0): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job "${id}" not found`);

    const available = this.drainPendingOutput(job);
    if (available || !job.running || waitMs <= 0) return available;

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const finish = () => {
        clearTimeout(timer);
        job.outputWaiters.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, Math.min(waitMs, 10_000));
      job.outputWaiters.add(finish);
    });

    return this.drainPendingOutput(job);
  }

  private drainPendingOutput(job: Job): string {
    const output = job.pendingOutputBuffer.join("");
    job.pendingOutputBuffer = [];
    job.pendingOutputBytes = 0;
    return output;
  }

  getJobOutput(id: string, limitBytes?: number): string {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job "${id}" not found`);
    const full = job.outputBuffer.join("");
    if (limitBytes && limitBytes > 0 && full.length > limitBytes) {
      return full.slice(-limitBytes);
    }
    return full;
  }

  listJobs(): JobSummary[] {
    const list: JobSummary[] = [];
    for (const job of this.jobs.values()) {
      list.push({
        id: job.id,
        command: job.command,
        cwd: job.cwd,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        pid: job.pid,
        running: job.running,
        exit_code: job.exitCode,
        signal: job.signal ? String(job.signal) : null,
        output_bytes: job.totalBytes,
      });
    }
    return list.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  }

  stopJob(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Job "${id}" not found`);
    if (!job.running || !job.pid) return false;

    try {
      // Try killing the process group
      process.kill(-job.pid, signal);
    } catch {
      try {
        process.kill(job.pid, signal);
      } catch {
        // Process might already be dead
      }
    }
    return true;
  }
}

export const jobManager = new JobManager();
