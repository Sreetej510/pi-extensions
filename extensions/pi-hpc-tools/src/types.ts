export interface HPCConfig {
	username: string;
	host: string;
	password: string;
	plinkPath?: string;
	enabledProjects?: string[];
}

export type HpcToolRenderResult = {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
};

export type HpcExecResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
	killed?: boolean;
};
