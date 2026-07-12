/** Text-based progress bar rendered via ctx.ui.setWidget while a run is in flight. */

export const PROGRESS_WIDGET_KEY = "checks_progress";
const PROGRESS_BAR_WIDTH = 24;

export function renderProgressLines(label: string, done: number, total: number): string[] {
	const ratio = total > 0 ? Math.min(1, done / total) : 0;
	const filled = Math.round(PROGRESS_BAR_WIDTH * ratio);
	const bar = "█".repeat(filled) + "░".repeat(Math.max(0, PROGRESS_BAR_WIDTH - filled));
	return [`checks: ${label} [${bar}] ${done}/${total}`];
}
