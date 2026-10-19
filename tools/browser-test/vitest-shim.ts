/**
 * A tiny stand-in for the parts of Vitest the specs use, so the same spec files can run in a real
 * browser (see tools/browser-test/README.md). It is not a test framework; use `npm test` normally.
 */
type Fn = () => unknown | Promise<unknown>;
interface Case { readonly name: string; readonly fn: Fn }
export const cases: Case[] = [];
const prefix: string[] = [];

export function describe(name: string, fn: () => void): void { prefix.push(name); fn(); prefix.pop(); }
export function it(name: string, fn: Fn): void { cases.push({ name: [...prefix, name].join(' > '), fn }); }
export const test = it;

const show = (v: unknown): string => { try { return JSON.stringify(v); } catch { return String(v); } };
function sameValue(a: unknown, b: unknown): boolean { return show(a) === show(b); }

function matchers(actual: unknown, negate: boolean) {
	const check = (pass: boolean, msg: string): void => { if (pass === negate) throw new Error((negate ? 'NOT: ' : '') + msg); };
	return {
		toBe: (e: unknown) => check(Object.is(actual, e), `expected ${show(actual)} to be ${show(e)}`),
		toEqual: (e: unknown) => check(sameValue(actual, e), `expected ${show(actual)} to equal ${show(e)}`),
		toContain: (e: unknown) => check(typeof actual === 'string' ? actual.includes(String(e)) : Array.isArray(actual) && actual.includes(e), `expected ${show(actual)} to contain ${show(e)}`),
		toBeTruthy: () => check(!!actual, `expected ${show(actual)} to be truthy`),
		toBeGreaterThan: (n: number) => check(typeof actual === 'number' && actual > n, `expected ${show(actual)} > ${n}`),
		toThrow: (msg?: string) => {
			let thrown: unknown = null;
			try { if (typeof actual === 'function') actual(); } catch (e) { thrown = e; }
			check(thrown !== null && (!msg || String(thrown instanceof Error ? thrown.message : thrown).includes(msg)), `expected function to throw ${msg ?? ''}, got ${show(thrown instanceof Error ? thrown.message : thrown)}`);
		},
	};
}

export function expect(actual: unknown) {
	return {
		...matchers(actual, false),
		not: matchers(actual, true),
		rejects: {
			async toThrow(msg?: string): Promise<void> {
				try { await actual; } catch (e) {
					const m = e instanceof Error ? e.message : String(e);
					if (msg && !m.includes(msg)) throw new Error(`expected rejection containing "${msg}", got "${m}"`);
					return;
				}
				throw new Error('expected the promise to reject');
			},
		},
	};
}
