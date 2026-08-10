import { readFileSync } from "node:fs";
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

function profileVcpus(profile: FargateResourceProfile): number {
  return profile === "small" ? 1 : profile === "medium" ? 2 : 4;
}

function readCpu(vcpus: number): CpuReading | undefined {
  try {
    const stats = readFileSync("/sys/fs/cgroup/cpu.stat", "utf-8");
    const usageUsec = Number.parseInt(stats.match(/^usage_usec\s+(\d+)/m)?.[1] ?? "", 10);
    if (Number.isFinite(usageUsec)) return { usageMicros: usageUsec, vcpus };
  } catch {
    // Try cgroup v1 below.
  }
  const usageNsec = readNumber("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  if (usageNsec !== undefined) return { usageMicros: usageNsec / 1000, vcpus };
  return undefined;
}

export class TaskResourceUsageSampler {
  private readonly startedAt = Date.now();
  private readonly profile: FargateResourceProfile;
  private readonly vcpus: number;
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
    this.vcpus = profileVcpus(profile);
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
      allocatedVcpus: this.vcpus,
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
    const cpu = readCpu(this.vcpus);
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
