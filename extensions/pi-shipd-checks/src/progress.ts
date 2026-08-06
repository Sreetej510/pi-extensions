/** Text-based progress bar rendered via ctx.ui.setWidget while a run is in flight. */

export const PROGRESS_WIDGET_KEY = "checks_progress";
const PROGRESS_BAR_WIDTH = 24;

export interface ProgressRenderOptions {
  /** Hide the numeric bar while remote work is being prepared. */
  showBar?: boolean;
  /** Start time for the run, used to display elapsed time. */
  startedAt?: number;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function renderProgressLines(
  label: string,
  done: number,
  total: number,
  options?: ProgressRenderOptions,
): string[] {
  const showBar = options?.showBar !== false;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  const filled = Math.round(PROGRESS_BAR_WIDTH * ratio);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
  const progress = showBar ? ` [${bar}] ${done}/${total}` : "";
  const elapsed = options?.startedAt === undefined ? "" : `  elapsed: ${formatElapsed(Date.now() - options.startedAt)}`;
  return [`checks: ${label}${progress}${elapsed}`];
}
