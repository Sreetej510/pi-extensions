import type { ReviewerRole } from "./types.js";

/** The 3 focus reviewers. Their prompt text (`focus`) lives in prompts.ts, not here. */
export const ROLES: ReviewerRole[] = [
	{
		key: "description",
		label: "Description",
		rubricHeading: /^## The problem description/i,
	},
	{
		key: "tests",
		label: "Tests",
		rubricHeading: /^## The tests/i,
	},
	{
		key: "solution",
		label: "Solution",
		rubricHeading: /^## The solution/i,
	},
];
