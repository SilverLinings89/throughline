import { describe, expect, it } from 'vitest';
import { AiEngine, parseModelJson, pickAnswer, stripThinking } from '../src/app/core/ai/engine';
import { URGENT, type AiConfig, type Job, type WorkerEvent } from '../src/app/core/ai/protocol';

const config: AiConfig = { baseUrl: 'http://model.test/v1', model: 'm', apiKey: '', temperature: 0.2, concurrency: 1, structured: 'auto', timeoutSec: 10, maxTokens: 0 };
const job = (key: string, priority: number, extra: Partial<Job> = {}): Job => ({ key, kind: 'para', priority, label: key, messages: [{ role: 'user', content: key }], json: true, ...extra });
const reply = (content: string): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const tick = (ms = 0): Promise<void> => new Promise(r => setTimeout(r, ms));

function harness(fetchImpl: typeof fetch) {
	const events: WorkerEvent[] = [];
	const engine = new AiEngine(e => events.push(e), fetchImpl);
	return { engine, events, done: () => events.filter(e => e.type === 'done') };
}

describe('model output parsing', () => {
	it('strips thinking, fences and trailing commas', () => {
		expect(parseModelJson('<think>hm</think>```json\n{"a": [1, 2,],}\n```')).toEqual({ a: [1, 2] });
		expect(stripThinking('<think>still thinking')).toBe('');
	});
	it('drops thoughts whose opening tag was in the prompt', () => {
		expect(stripThinking('Let me think {about} it.</think>\n{"a":1}')).toBe('{"a":1}');
	});
	it('takes a JSON answer from the reasoning field when content is empty, but never for plain text', () => {
		expect(pickAnswer('', '{"a":1}', true)).toBe('{"a":1}');
		expect(pickAnswer('{"b":2}', 'thinking {x}', true)).toBe('{"b":2}');
		expect(pickAnswer('', 'just thoughts', false)).toBe('');
	});
	it('throws when there is no JSON object', () => {
		expect(() => parseModelJson('no json here')).toThrow('did not return JSON');
	});
});

describe('AI engine', () => {
	it('reads a schema-constrained answer that LM Studio filed as reasoning', async () => {
		const body = { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '{"ok":1}' } }] };
		const { engine, done } = harness(async () => new Response(JSON.stringify(body)));
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a', 1, { schema: { type: 'object' } })] });
		await tick(20);
		expect(done().map(e => e.type === 'done' && e.result)).toEqual([{ ok: 1 }]);
	});

	it('falls back from JSON schema to JSON mode and remembers it', async () => {
		const formats: unknown[] = [];
		const { engine, events, done } = harness(async (_url, init) => {
			const body: { response_format?: { type: string } } = JSON.parse(String(init?.body));
			formats.push(body.response_format?.type);
			return body.response_format?.type === 'json_schema' ? new Response('no', { status: 400 }) : reply('{"ok":1}');
		});
		engine.handle({ type: 'config', config });
		const schema = { type: 'object' };
		engine.handle({ type: 'enqueue', jobs: [job('a', 1, { schema }), job('b', 1, { schema })] });
		await tick(30);
		expect(done().map(e => e.type === 'done' && e.key)).toEqual(['a', 'b']);
		expect(formats).toEqual(['json_schema', 'json_object', 'json_object']);
		expect(events.some(e => e.type === 'format' && e.mode === 'json_object')).toBe(true);
	});

	it('never records JSON schema support from a job that had no schema', async () => {
		const formats: unknown[] = [];
		const { engine, events } = harness(async (_url, init) => { formats.push(JSON.parse(String(init?.body)).response_format?.type); return reply('{}'); });
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a', 1)] });
		await tick(20);
		expect(formats).toEqual(['json_object']);
		expect(events.some(e => e.type === 'format' && e.mode === 'json_object')).toBe(true);
	});

	it('runs higher priority first and starts nothing new while held, except urgent jobs', async () => {
		const order: string[] = [];
		const { engine } = harness(async (_url, init) => { order.push(JSON.parse(String(init?.body)).messages[0].content); return reply('{}'); });
		engine.handle({ type: 'hold', ms: 60 });
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('low', 1), job('high', 50)] });
		await tick(20);
		expect(order).toEqual([]);
		engine.handle({ type: 'enqueue', jobs: [job('urgent', URGENT)] });
		await tick(20);
		expect(order).toEqual(['urgent']);
		await tick(120);
		expect(order).toEqual(['urgent', 'high', 'low']);
	});

	it('lets a running job finish when an urgent one arrives, instead of starting it over', async () => {
		const started: string[] = [];
		let release: () => void = () => {};
		const { engine, events } = harness((_url, init) => new Promise(resolve => {
			const k = JSON.parse(String(init?.body)).messages[0].content;
			started.push(k);
			if (k === 'slow') release = () => resolve(reply('{}')); else resolve(reply('{}'));
		}));
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('slow', 1)] });
		await tick(5);
		engine.handle({ type: 'enqueue', jobs: [job('urgent', URGENT)] });
		await tick(5);
		expect(started).toEqual(['slow']);
		release();
		await tick(20);
		expect(started).toEqual(['slow', 'urgent']);
		expect(events.some(e => e.type === 'error')).toBe(false);
	});

	it('sends a job answer length limit unless one is configured', async () => {
		const limits: unknown[] = [];
		const { engine } = harness(async (_url, init) => { limits.push(JSON.parse(String(init?.body)).max_tokens); return reply('{}'); });
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a', 1, { maxTokens: 1500 })] });
		await tick(20);
		engine.handle({ type: 'config', config: { ...config, maxTokens: 800 } });
		engine.handle({ type: 'enqueue', jobs: [job('b', 1, { maxTokens: 1500 })] });
		await tick(20);
		expect(limits).toEqual([1500, 800]);
	});

	it('reports an unreachable server in words a person can act on', async () => {
		const { engine, events } = harness(async () => { throw new TypeError('Failed to fetch'); });
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a', 1)] });
		await tick(20);
		const err = events.find(e => e.type === 'error');
		expect(err?.type === 'error' && err.error).toContain('Could not reach http://model.test/v1');
	});

	it('does not report cancelled jobs as failures', async () => {
		let release: () => void = () => {};
		const { engine, events } = harness((_url, init) => new Promise((resolve, reject) => {
			release = () => resolve(reply('{}'));
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
		}));
		engine.handle({ type: 'config', config });
		engine.handle({ type: 'enqueue', jobs: [job('a', 1)] });
		await tick(5);
		engine.handle({ type: 'cancel', keys: ['a'] });
		await tick(5);
		release();
		const err = events.find(e => e.type === 'error');
		expect(err?.type === 'error' && err.reason).toBe('cancelled');
	});
});
