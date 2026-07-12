import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CommandArgumentCompletion = {
  value: string;
  label: string;
  description?: string;
};

export type UsageSource = "pi-auth" | "codex-app-server" | "anthropic-oauth";
export type PiModel = NonNullable<ExtensionContext["model"]>;
export type ProviderUsageModel = Pick<PiModel, "id" | "name" | "provider">;

export type QueryUsageOptions = {
  clearStatusline: boolean;
  consumeBankedReset: boolean;
  consumeBankedResetId?: string;
  listBankedResets: boolean;
  raw: boolean;
  refresh: boolean;
  statusline: boolean;
  timeoutMs: number;
};

export type CachedReport = {
  createdAt: number;
  report: UsageReport;
};

export type QueryUsageResult = { ok: true; report: UsageReport } | { ok: false; errors: UsageQueryError[] };

export type UsageQueryError = {
  source: UsageSource;
  message: string;
  cause?: unknown;
};

export type CodexUsageReport = {
  provider: "codex";
  source: "pi-auth" | "codex-app-server";
  capturedAt: number;
  planType?: string;
  bankedResetsAvailable?: number;
  snapshots: NormalizedRateLimitSnapshot[];
};

export type AnthropicUsageReport = {
  provider: "anthropic";
  source: "anthropic-oauth";
  capturedAt: number;
  summaryLines: string[];
  statusline: string;
};

export type UsageReport = CodexUsageReport | AnthropicUsageReport;

export type NormalizedRateLimitSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
  credits?: NormalizedCredits;
};

export type NormalizedRateLimitWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
};

export type NormalizedCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

export type RateLimitStatusPayload = {
  plan_type?: unknown;
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
};

export type BackendRateLimitDetails = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

export type BackendWindowSnapshot = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
};

export type BackendAdditionalRateLimit = {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: unknown;
};

export type BackendCreditsSnapshot = {
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
};

export type BackendRateLimitResetCredits = {
  available_count?: unknown;
  availableCount?: unknown;
};

export type AppServerRateLimitResponse = {
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
  rateLimitResetCredits?: unknown;
};

export type AppServerRateLimitSnapshot = {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  planType?: unknown;
};

export type AppServerWindowSnapshot = {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
};

export type AppServerCreditsSnapshot = {
  hasCredits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
};

export type AppServerRateLimitResetCredits = {
  availableCount?: unknown;
  available_count?: unknown;
};

export type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

export type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type AnthropicOAuthWindow = {
  utilization?: unknown;
  resets_at?: unknown;
  limit_dollars?: unknown;
  used_dollars?: unknown;
};

export type AnthropicExtraUsage = {
  is_enabled?: unknown;
  used_credits?: unknown;
  monthly_limit?: unknown;
  currency?: unknown;
  utilization?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
};

export type AnthropicOAuthUsagePayload = Record<string, unknown> & {
  five_hour?: unknown;
  seven_day?: unknown;
  extra_usage?: unknown;
};

export type CodexResetCreditPayload = {
  available_count?: unknown;
  availableCount?: unknown;
  credits?: unknown;
};

export type CodexResetCreditRowPayload = {
  id?: unknown;
  reset_type?: unknown;
  resetType?: unknown;
  status?: unknown;
  granted_at?: unknown;
  grantedAt?: unknown;
  expires_at?: unknown;
  expiresAt?: unknown;
};

export type CodexResetCredit = {
  id: string;
  resetType?: string;
  status?: string;
  grantedAt?: string;
  expiresAt?: string;
};

export type CodexResetCreditList = {
  availableCount: number;
  credits: CodexResetCredit[];
};

export type UsageProviderKey = "codex" | "anthropic";

export type SharedCacheEntry = { createdAt: number; report: UsageReport };

export type SharedUsageCache = {
  version: number;
  entries: Partial<Record<UsageProviderKey, SharedCacheEntry>>;
  backoffUntil?: Partial<Record<UsageProviderKey, number>>;
};

export type FooterTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};
export type FooterTui = { requestRender: () => void };
export type FooterDataView = {
  getGitBranch: () => string | null;
  getExtensionStatuses: () => ReadonlyMap<string, string>;
  getAvailableProviderCount: () => number;
  onBranchChange: (callback: () => void) => () => void;
};
