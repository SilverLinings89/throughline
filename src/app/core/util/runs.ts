import type { Run, TextRun } from '../model';

/** Creates a text run. */
export function textRun(t: string, f: { b?: boolean; i?: boolean; href?: string | null } = {}): TextRun {
	return { kind: 'text', t, b: !!f.b, i: !!f.i, href: f.href ?? null };
}

/** Joins neighbouring text runs with the same formatting and drops empty ones. */
export function mergeRuns(runs: readonly Run[]): Run[] {
	const out: Run[] = [];
	for (const r of runs) {
		if (r.kind === 'token') { out.push(r); continue; }
		if (!r.t) continue;
		const prev = out[out.length - 1];
		if (prev && prev.kind === 'text' && prev.b === r.b && prev.i === r.i && prev.href === r.href) {
			out[out.length - 1] = { ...prev, t: prev.t + r.t };
		} else {
			out.push(textRun(r.t, r));
		}
	}
	return out;
}

/** Plain text of runs, without tokens. */
export function runsText(runs: readonly Run[]): string {
	let s = '';
	for (const r of runs) if (r.kind === 'text') s += r.t;
	return s;
}
