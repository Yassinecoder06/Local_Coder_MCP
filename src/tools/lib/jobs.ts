import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";

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
  batchCommands?: string[];
  batchStopOnError?: boolean;
}

export interface Service {
  name: string;
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string | null;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  port?: number;
  child: ChildProcess | null;
  outputBuffer: string[];
  totalBytes: number;
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
  output_truncated?: boolean;
}

const MAX_JOBS = 20;
const MAX_JOB_OUTPUT_BYTES = 200_000;
const MAX_SERVICES = 10;
const MAX_SERVICE_OUTPUT_BYTES = 256 * 1024;

class JobManager {
  private jobs = new Map<string, Job>();
  private services = new Map<string, Service>();

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
    timeoutMs: number = 120_000,
    batch?: { commands: string[]; stopOnError: boolean }
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
      batchCommands: batch?.commands,
      batchStopOnError: batch?.stopOnError,
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
      const output = job.outputBuffer.join("");
      return {
        job_id: id,
        running: false,
        output,
        exit_code: job.exitCode,
        output_truncated: job.totalBytes > Buffer.byteLength(output, "utf-8"),
      };
    }

    this.drainPendingOutput(job);
    const output = job.outputBuffer.join("");
    return {
      job_id: id,
      running: true,
      output,
      output_so_far: output,
      exit_code: null,
      pid: job.pid,
      output_truncated: job.totalBytes > Buffer.byteLength(output, "utf-8"),
    };
  }

  private async waitForServiceExit(service: Service, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (service.running && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  async startService(
    name: string,
    command: string,
    cwd: string,
    port?: number,
    waitMs = 3000
  ): Promise<Service> {
    const deadline = Date.now() + Math.min(3000, Math.max(0, waitMs));
    const previous = this.services.get(name);
    if (previous?.running) {
      this.stopService(name, "SIGTERM");
      await this.waitForServiceExit(previous, Math.min(500, Math.max(0, deadline - Date.now())));
      if (previous.running) {
        this.stopService(name, "SIGKILL");
        await this.waitForServiceExit(previous, Math.min(500, Math.max(0, deadline - Date.now())));
      }
    }
    if (!previous && [...this.services.values()].filter((item) => item.running).length >= MAX_SERVICES) {
      throw new Error(`Service limit reached (${MAX_SERVICES}); stop a running service before starting another`);
    }
    if (!previous && this.services.size >= MAX_SERVICES) {
      const oldestStopped = [...this.services.values()]
        .filter((item) => !item.running)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0];
      if (oldestStopped) this.services.delete(oldestStopped.name);
    }

    const service: Service = {
      name, command, cwd, startedAt: new Date().toISOString(), finishedAt: null,
      pid: null, running: true, exitCode: null, signal: null, port, child: null,
      outputBuffer: [], totalBytes: 0,
    };
    const env: NodeJS.ProcessEnv = {
      ...process.env, CI: "true", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1",
    };
    const child = spawn("bash", ["-lc", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    service.child = child;
    service.pid = child.pid ?? null;
    this.services.set(name, service);

    const append = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      service.outputBuffer.push(text);
      service.totalBytes += Buffer.byteLength(text, "utf-8");
      while (service.totalBytes > MAX_SERVICE_OUTPUT_BYTES && service.outputBuffer.length > 0) {
        const excess = service.totalBytes - MAX_SERVICE_OUTPUT_BYTES;
        const first = service.outputBuffer[0];
        const firstBytes = Buffer.byteLength(first, "utf-8");
        if (firstBytes <= excess) {
          service.outputBuffer.shift();
          service.totalBytes -= firstBytes;
        } else {
          const trimmed = Buffer.from(first).subarray(excess).toString("utf-8");
          service.outputBuffer[0] = trimmed;
          service.totalBytes += Buffer.byteLength(trimmed, "utf-8") - firstBytes;
        }
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") append(`\nstdin error: ${err.message}\n`);
    });
    child.on("close", (code, signal) => {
      service.running = false;
      service.exitCode = code;
      service.signal = signal;
      service.finishedAt = new Date().toISOString();
      service.child = null;
    });
    child.on("error", (err) => {
      append(`\nProcess error: ${err.message}\n`);
      service.running = false;
      service.exitCode = 1;
      service.finishedAt = new Date().toISOString();
      service.child = null;
    });

    while (service.running && Date.now() < deadline) {
      if (service.outputBuffer.length > 0) break;
      if (port !== undefined && await this.portHealthy(port, Math.min(150, Math.max(1, deadline - Date.now())))) {
        const outputDeadline = Math.min(deadline, Date.now() + 100);
        while (service.running && service.outputBuffer.length === 0 && Date.now() < outputDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return service;
  }

  private portHealthy(port: number, timeoutMs = 300): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
      const finish = (healthy: boolean) => { clearTimeout(timer); socket.destroy(); resolve(healthy); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
  }

  async listServices(): Promise<Array<Record<string, unknown>>> {
    const list = await Promise.all([...this.services.values()].map(async (service) => ({
      name: service.name,
      pid: service.pid,
      running: service.running,
      exit_code: service.exitCode,
      uptime_ms: Date.now() - Date.parse(service.startedAt),
      port: service.port ?? null,
      port_healthy: service.port === undefined ? null : await this.portHealthy(service.port),
    })));
    return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  getService(name: string): Service | undefined { return this.services.get(name); }

  getServiceOutput(name: string, lines = 100): string {
    const service = this.services.get(name);
    if (!service) throw new Error(`Service "${name}" not found`);
    return service.outputBuffer.join("").split(/\r?\n/).slice(-Math.max(1, lines)).join("\n");
  }

  stopService(name: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
    const service = this.services.get(name);
    if (!service) throw new Error(`Service "${name}" not found`);
    if (!service.running || !service.pid) return false;
    try { process.kill(-service.pid, signal); }
    catch {
      try { process.kill(service.pid, signal); } catch { /* process already exited */ }
    }
    return true;
  }

  batchProgress(id: string): { current_index: number | null; commands: Array<{ index: number; command: string; status: string; exit_code: number | null; output: string }> } | undefined {
    const job = this.jobs.get(id);
    if (!job?.batchCommands) return undefined;
    const captured = job.outputBuffer.join("");
    const captureTruncated = job.totalBytes > Buffer.byteLength(captured, "utf-8");
    let runningIndex: number | null = null;
    const commands = job.batchCommands.map((command, index) => {
      const label = `[${index + 1}/${job.batchCommands!.length}] $ ${command}`;
      const exitLabel = `[${index + 1}/${job.batchCommands!.length}] exit code: `;
      const begin = captured.indexOf(label);
      if (begin < 0) {
        if (captureTruncated && runningIndex === null) {
          return { index: index + 1, command, status: "unknown (output capture limit)", exit_code: null, output: "Output unavailable because the job output ring buffer was exceeded." };
        }
        const priorFailed = job.batchStopOnError && job.batchCommands!.slice(0, index).some((_, priorIndex) => {
          const priorLabel = `[${priorIndex + 1}/${job.batchCommands!.length}] exit code: `;
          const at = captured.indexOf(priorLabel);
          if (at < 0) return false;
          const value = Number(captured.slice(at + priorLabel.length).split(/\r?\n/, 1)[0]);
          return Number.isInteger(value) && value !== 0;
        });
        return { index: index + 1, command, status: priorFailed ? "skipped" : "pending", exit_code: null, output: "" };
      }
      const endMarker = captured.indexOf(exitLabel, begin + label.length);
      if (endMarker < 0) {
        if (job.running) runningIndex = index + 1;
        return {
          index: index + 1, command, status: job.running ? "running" : "incomplete",
          exit_code: null, output: captured.slice(begin),
        };
      }
      const end = captured.indexOf("\n", endMarker);
      const exitCode = Number(captured.slice(endMarker + exitLabel.length, end < 0 ? undefined : end));
      return {
        index: index + 1, command, status: Number.isInteger(exitCode) ? "completed" : "incomplete",
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        output: captured.slice(begin, end < 0 ? undefined : end + 1),
      };
    });
    const current = commands.find((item) => item.status === "running");
    const firstPending = job.running ? commands.find((item) => item.status === "pending") : undefined;
    return { current_index: current?.index ?? firstPending?.index ?? null, commands };
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
