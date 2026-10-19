import { cases } from './vitest-shim';
import '../../test/formats.spec';
import '../../test/analysis.spec';
import '../../test/engine.spec';
import '../../test/editor-dom.spec';

interface Result { readonly name: string; readonly ok: boolean; readonly error?: string; readonly ms: number }
declare global { interface Window { __results?: Result[] } }

async function run(): Promise<void> {
	const results: Result[] = [];
	for (const c of cases) {
		const t0 = performance.now();
		try { await c.fn(); results.push({ name: c.name, ok: true, ms: Math.round(performance.now() - t0) }); }
		catch (e) { results.push({ name: c.name, ok: false, error: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) }); }
	}
	window.__results = results;
	document.body.textContent = results.map(r => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `\n     ${r.error}` : ''}`).join('\n');
}
void run();
