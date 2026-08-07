import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import type { FargateResourceProfile, FargateResourceUsage } from "./types.js";

const SAMPLE_INTERVAL_MS = 5_000;
const CPU_THRESHOLD_PERCENT = 90;
const CPU_HIGH_THRESHOLD_PERCENT = 95;

type CpuReading = { usageMicros: number; vcpus: number };

function readNumber(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readCpuVcpus(): number {
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf-8").trim().split(/\s+/);
    const quotaValue = Number.parseFloat(quota ?? "");
    const periodValue = Number.parseFloat(period ?? "");
    if (quota !== "max" && quotaValue > 0 && periodValue > 0) return quotaValue / periodValue;
  } catch {
    // Try cgroup v1 below.
  }
  const quota = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_quota_us");
  const period = readNumber("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  if (quota !== undefined && period !== undefined && quota > 0 && period > 0) return quota / period;
  return Math.max(1, cpus().length);
}

function readCpu(): CpuReading | undefined {
  try {
    const stats = readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
    const usageUsec = Number.parseInt(stats.match(/^usage_usec\s+(\d+)/m)?.[1] ?? "", 10);
    if (Number.isFinite(usageUsec)) return { usageMicros: usageUsec, vcpus: readCpuVcpus() };
  } catch {
    // Try cgroup v1 below.
  }
  const usageNsec = readNumber("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  if (usageNsec !== undefined) return { usageMicros: usageNsec / 1000, vcpus: readCpuVcpus() };
  return undefined;
}

export class TaskResourceUsageSampler {
  private readonly startedAt = Date.now();
  private readonly profile: FargateResourceProfile;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastCpu: CpuReading | undefined;
  private lastSampleAt: number | undefined;
  private sampleCount = 0;
  private observedMs = 0;
  private cpuOver90Ms = 0;
  private cpuOver95Ms = 0;
  private maxCpuPercent: number | null = null;
  private stopped: FargateResourceUsage | undefined;

  constructor(profile: FargateResourceProfile) {
    this.profile = profile;
  }

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
  }

  stop(): FargateResourceUsage {
    if (this.stopped) return this.stopped;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
    this.stopped = this.snapshot();
    return this.stopped;
  }

  snapshot(): FargateResourceUsage {
    return {
      profile: this.profile,
      durationMs: Date.now() - this.startedAt,
      sampleCount: this.sampleCount,
      maxCpuPercent: this.maxCpuPercent,
      cpuOver90DurationMs: this.observedMs > 0 ? this.cpuOver90Ms : null,
      cpuOver95DurationMs: this.observedMs > 0 ? this.cpuOver95Ms : null,
      observedAt: new Date().toISOString(),
    };
  }

  private sample(): void {
    if (this.stopped) return;
    const now = Date.now();
    const cpu = readCpu();
    this.sampleCount += 1;
    if (cpu && this.lastCpu && this.lastSampleAt !== undefined) {
      const elapsedMs = now - this.lastSampleAt;
      const usageDeltaMicros = Math.max(0, cpu.usageMicros - this.lastCpu.usageMicros);
      const cpuPercent = Math.max(0, Math.min(100, (usageDeltaMicros / (elapsedMs * 1000 * cpu.vcpus)) * 100));
      this.observedMs += Math.max(0, elapsedMs);
      const intervalMs = Math.max(0, elapsedMs);
      if (cpuPercent >= CPU_THRESHOLD_PERCENT) this.cpuOver90Ms += intervalMs;
      if (cpuPercent >= CPU_HIGH_THRESHOLD_PERCENT) this.cpuOver95Ms += intervalMs;
      this.maxCpuPercent = this.maxCpuPercent === null ? cpuPercent : Math.max(this.maxCpuPercent, cpuPercent);
    }
    if (cpu) this.lastCpu = cpu;
    this.lastSampleAt = now;
  }
}
