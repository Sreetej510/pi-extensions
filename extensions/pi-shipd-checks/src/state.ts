/**
 * Module-level run state shared between the /checks command handler and the
 * cancel shortcut — encapsulated behind functions so both sides stay in sync
 * without either needing to reassign another module's bindings directly.
 */

let reviewInProgress = false;
let currentReviewAbort: AbortController | undefined;

export function isReviewInProgress(): boolean {
	return reviewInProgress;
}

/** Marks a run as started and returns the AbortController to pass down to the agents. */
export function startReview(): AbortController {
	reviewInProgress = true;
	currentReviewAbort = new AbortController();
	return currentReviewAbort;
}

export function endReview(): void {
	reviewInProgress = false;
	currentReviewAbort = undefined;
}

/** Returns true if a cancel was actually requested (i.e. a run was in progress and not already cancelled). */
export function cancelReview(): boolean {
	if (!reviewInProgress || !currentReviewAbort || currentReviewAbort.signal.aborted) return false;
	currentReviewAbort.abort();
	return true;
}
