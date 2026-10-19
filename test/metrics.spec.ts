import { describe, expect, it } from 'vitest';
import { AiEngine } from '../src/app/core/ai/engine';
import { advice, parseMetrics, summarize, type RequestMetric } from '../src/app/core/ai/metrics';
import type { AiConfig, Job, WorkerEvent } from '../src/app/core/ai/protocol';
import { detectLanguage, isLanguageTag } from '../src/app/core/text/lang';

const config: AiConfig = { baseUrl: 'http://model.test/v1', model: 'm', apiKey: '', temperature: 0.2, concurrency: 1, structured: 'json_object', timeoutSec: 10, maxTokens: 0 };
const job = (key: string): Job => ({ key, kind: 'para', priority: 1, label: key, messages: [{ role: 'user', content: 'x'.repeat(400) }], json: true });
const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));
const metric = (extra: Partial<RequestMetric>): RequestMetric => ({ at: 0, key: 'k', kind: 'para', model: 'm', waitMs: 0, ms: 1000, firstTokenMs: null, promptTokens: 100, completionTokens: 50, estimated: false, attempts: 1, outcome: 'ok', ...extra });

function metrics(events: WorkerEvent[]): RequestMetric[] {
	return events.flatMap(e => (e.type === 'metric' ? [e.metric] : []));
}

describe('request metrics', () => {
	it('reports server token counts and posts the metric before the result', async () => {
		const events: WorkerEvent[] = [];
		const engine = new AiEngine(e => events.push(e), async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 123, completion_tokens: 7 } })));
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a')] });
		await tick(20);
		const [m] = metrics(events);
		expect(m).toMatchObject({ key: 'a', kind: 'para', model: 'm', promptTokens: 123, completionTokens: 7, estimated: false, attempts: 1, outcome: 'ok' });
		expect(events.findIndex(e => e.type === 'metric')).toBeLessThan(events.findIndex(e => e.type === 'done'));
	});

	it('estimates tokens without usage and marks non-JSON answers as unusable', async () => {
		const events: WorkerEvent[] = [];
		const engine = new AiEngine(e => events.push(e), async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] })));
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a')] });
		await tick(20);
		expect(metrics(events)[0]).toMatchObject({ promptTokens: 100, completionTokens: 4, estimated: true, outcome: 'invalid' });
	});

	it('summarizes times, failures and throughput', () => {
		const s = summarize([metric({ ms: 1000 }), metric({ ms: 3000 }), metric({ ms: 2000, outcome: 'invalid' }), metric({ outcome: 'timeout' }), metric({ outcome: 'cancelled' })]);
		expect(s).toMatchObject({ requests: 5, ok: 2, invalid: 1, failed: 1, timeouts: 1, dropped: 1, medianMs: 2000, p90Ms: 3000 });
		expect(s.tokensPerSec).toBeCloseTo(100 / 4);
	});

	it('suggests a smaller model when paragraphs are slow, and a larger one when answers are unusable', () => {
		const slow = Array.from({ length: 6 }, () => metric({ ms: 60e3 }));
		expect(advice(slow, 4).join(' ')).toMatch(/smaller/);
		const broken = Array.from({ length: 6 }, (_, i) => metric({ ms: 2000, outcome: i < 2 ? 'invalid' : 'ok' }));
		expect(advice(broken, 4).join(' ')).toMatch(/larger model/);
	});

	it('drops malformed stored entries', () => {
		expect(parseMetrics([metric({}), { kind: 'nope' }, null, 3])).toHaveLength(1);
		expect(parseMetrics('garbage')).toEqual([]);
	});
});

describe('text language', () => {
	it('recognises German and English, and stays quiet on too little text', () => {
		expect(detectLanguage('Die Frage ist nicht, ob das Verfahren funktioniert, sondern wie es sich auf die Arbeit der Teams auswirkt und was dafür nötig ist.')).toBe('de-DE');
		expect(detectLanguage('The question is not whether the method works, but how it affects the work of the teams and what it takes to make that happen.')).toBe('en');
		expect(detectLanguage('Kurz.')).toBeNull();
	});
	it('accepts only plausible language tags', () => {
		expect(isLanguageTag('de-DE')).toBe(true);
		expect(isLanguageTag('Deutsch!')).toBe(false);
	});
});
