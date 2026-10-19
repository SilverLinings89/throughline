/** Structured diagnostics. Shipped code logs through here, never through console.log. */
export const log = {
	warn(event: string, detail: Record<string, unknown> = {}): void {
		console.warn(`[throughline] ${event}`, detail);
	},
	error(event: string, detail: Record<string, unknown> = {}): void {
		console.error(`[throughline] ${event}`, detail);
	},
};

/** Turns any thrown value into a message for the interface. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
