/**
 * The AI job queue. Runs inside a Web Worker (see `workers/ai.worker.ts`), so network calls,
 * JSON parsing and retries never touch the editor's thread.
 *
 * - Jobs run by priority, `concurrency` at a time.
 * - `hold` pauses new starts while the user types; running jobs continue.
 * - An urgent job goes to the front of the queue. Running jobs are never interrupted for it, so no
 *   work is thrown away and started again.
 * - In `auto` mode the engine tries JSON schema, then JSON mode, then plain text, and keeps what works.
 */
import { estimateTokens, type MetricOutcome } from './metrics';
import { URGENT, type AiConfig, type Job, type ResolvedMode, type WorkerCommand, type WorkerEvent } from './protocol';

type Abort = 'cancelled' | 'timeout';
interface Running { readonly job: Job; readonly ctrl: AbortController; reason: Abort | null }
/** What one job's requests cost, filled in while it runs. */
interface Usage { attempts: number; promptTokens: number | null; completionTokens: number | null; firstTokenMs: number | null; answerChars: number }

/**
 * Removes `<think>` blocks that reasoning models emit, including an unclosed one while streaming,
 * and leading thoughts whose opening tag the chat template already put in the prompt (Qwen 3).
 */
export function stripThinking(s: string): string {
	const out = s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
	const close = out.indexOf('</think>');
	return (close >= 0 ? out.slice(close + 8) : out).trim();
}

/**
 * The answer from a reply's `content` and its separate reasoning field. Servers that parse
 * reasoning (LM Studio, Ollama, vLLM) move it out of `content`. When a JSON schema constrains the
 * output, LM Studio files the whole JSON answer as reasoning and leaves `content` empty, so a JSON
 * job falls back to the reasoning when `content` holds no JSON. Plain-text answers never do, so a
 * chat reply does not show the model's thoughts.
 */
export function pickAnswer(content: string, reasoning: string, json: boolean): string {
	const answer = stripThinking(content);
	if (!json || answer.includes('{') || !reasoning.includes('{')) return answer;
	return stripThinking(reasoning);
}

/** Extracts the first JSON object from model output: tolerates fences, prose and trailing commas. */
export function parseModelJson(text: string): unknown {
	let s = stripThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
	const a = s.indexOf('{');
	const b = s.lastIndexOf('}');
	if (a < 0 || b < a) throw new Error('The model did not return JSON.');
	s = s.slice(a, b + 1);
	try { return JSON.parse(s); } catch { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); }
}

export class AiEngine {
	private config: AiConfig | null = null;
	private queue: Job[] = [];
	private readonly running = new Map<string, Running>();
	/** When each queued key was first enqueued, for the time it waited. */
	private readonly enqueuedAt = new Map<string, number>();
	private holdUntil = 0;
	private mode: ResolvedMode | null = null;
	private pumpTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly post: (e: WorkerEvent) => void, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

	handle(cmd: WorkerCommand): void {
		switch (cmd.type) {
			case 'config': {
				const changed = !this.config || this.config.baseUrl !== cmd.config.baseUrl || this.config.structured !== cmd.config.structured;
				this.config = cmd.config;
				if (changed) this.mode = cmd.config.structured === 'auto' ? null : cmd.config.structured;
				this.pump();
				break;
			}
			case 'enqueue':
				for (const job of cmd.jobs) {
					if (this.running.has(job.key)) continue;
					if (!this.enqueuedAt.has(job.key)) this.enqueuedAt.set(job.key, Date.now());
					const i = this.queue.findIndex(j => j.key === job.key);
					if (i >= 0) this.queue[i] = job; else this.queue.push(job);
				}
				this.pump();
				break;
			case 'priority':
				for (const [key, p] of cmd.list) { const j = this.queue.find(x => x.key === key); if (j) j.priority = p; }
				this.pump();
				break;
			case 'cancel': {
				const keys = new Set(cmd.keys);
				this.queue = this.queue.filter(j => !keys.has(j.key));
				for (const k of keys) { if (!this.running.has(k)) this.enqueuedAt.delete(k); this.abort(k, 'cancelled'); }
				this.status();
				break;
			}
			case 'hold':
				this.holdUntil = Date.now() + cmd.ms;
				clearTimeout(this.pumpTimer);
				this.pumpTimer = setTimeout(() => this.pump(), cmd.ms + 40);
				break;
			case 'clear':
				this.queue = [];
				for (const k of this.enqueuedAt.keys()) if (!this.running.has(k)) this.enqueuedAt.delete(k);
				for (const k of [...this.running.keys()]) this.abort(k, 'cancelled');
				this.status();
				break;
			default: { const exhaustive: never = cmd; return exhaustive; }
		}
	}

	private abort(key: string, reason: Abort): void {
		const r = this.running.get(key);
		if (r) { r.reason = reason; r.ctrl.abort(); }
	}

	private status(): void {
		this.post({ type: 'status', queued: this.queue.length, running: [...this.running.values()].map(r => ({ key: r.job.key, kind: r.job.kind, label: r.job.label })) });
	}

	private pump(): void {
		const c = this.config;
		if (!c || !c.baseUrl || !c.model) { this.status(); return; }
		this.queue.sort((a, b) => b.priority - a.priority);
		while (this.running.size < Math.max(1, c.concurrency) && this.queue.length) {
			const next = this.queue[0];
			if (Date.now() < this.holdUntil && next.priority < URGENT) break;
			this.queue.shift();
			void this.start(next);
		}
		this.status();
	}

	private async start(job: Job): Promise<void> {
		const ctrl = new AbortController();
		const entry: Running = { job, ctrl, reason: null };
		const timer = setTimeout(() => { entry.reason = 'timeout'; ctrl.abort(); }, (this.config?.timeoutSec ?? 240) * 1000);
		this.running.set(job.key, entry);
		this.status();
		const startedAt = Date.now();
		const usage: Usage = { attempts: 0, promptTokens: null, completionTokens: null, firstTokenMs: null, answerChars: 0 };
		const measure = (outcome: MetricOutcome): void => this.measure(job, startedAt, usage, outcome);
		let text: string | null = null;
		try {
			text = await this.complete(job, ctrl.signal, usage, startedAt);
			const result = job.json ? parseModelJson(text) : text;
			measure('ok');
			this.post({ type: 'done', key: job.key, kind: job.kind, result });
		} catch (err) {
			const error = entry.reason === 'timeout' ? 'The model did not answer within the time limit.'
				: entry.reason === 'cancelled' ? 'Cancelled.' : err instanceof Error ? err.message : String(err);
			const reason = entry.reason ?? (text !== null ? 'invalid' : 'error');
			measure(reason);
			this.post({ type: 'error', key: job.key, kind: job.kind, error, reason });
		} finally {
			clearTimeout(timer);
			this.running.delete(job.key);
			this.pump();
		}
	}

	private measure(job: Job, startedAt: number, usage: Usage, outcome: MetricOutcome): void {
		const queuedAt = this.enqueuedAt.get(job.key) ?? startedAt;
		this.enqueuedAt.delete(job.key);
		const promptChars = job.messages.reduce((n, m) => n + m.content.length, 0);
		const estimated = usage.promptTokens === null || usage.completionTokens === null;
		this.post({ type: 'metric', metric: {
			at: startedAt, key: job.key, kind: job.kind, model: this.config?.model ?? '',
			waitMs: Math.max(0, startedAt - queuedAt), ms: Date.now() - startedAt, firstTokenMs: usage.firstTokenMs,
			promptTokens: usage.promptTokens ?? (usage.attempts ? estimateTokens(promptChars) : 0),
			completionTokens: usage.completionTokens ?? estimateTokens(usage.answerChars),
			estimated, attempts: Math.max(1, usage.attempts), outcome,
		} });
	}

	private async complete(job: Job, signal: AbortSignal, usage: Usage, startedAt: number): Promise<string> {
		const c = this.config;
		if (!c) throw new Error('No model is configured.');
		const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (c.apiKey) headers['Authorization'] = `Bearer ${c.apiKey}`;
		const base: Record<string, unknown> = { model: c.model, messages: job.messages, temperature: job.temperature ?? c.temperature, stream: !!job.stream };
		const maxTokens = c.maxTokens || job.maxTokens;
		if (maxTokens) base['max_tokens'] = maxTokens;
		const candidates: ResolvedMode[] = this.mode ? [this.mode] : ['json_schema', 'json_object', 'none'];
		// A job without a schema cannot test schema support, so it never runs (or records) that mode.
		const modes: ResolvedMode[] = !job.json ? ['none'] : job.schema ? candidates : candidates.map(m => (m === 'json_schema' ? 'json_object' : m)).filter((m, i, a) => a.indexOf(m) === i);
		let lastError: Error | null = null;
		for (const mode of modes) {
			const body = { ...base };
			if (mode === 'json_schema' && job.schema) body['response_format'] = { type: 'json_schema', json_schema: { name: job.kind, schema: job.schema } };
			else if (mode === 'json_object') body['response_format'] = { type: 'json_object' };
			let res: Response;
			usage.attempts++;
			try {
				res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
			} catch (e) {
				if (signal.aborted) throw e;
				throw new Error(`Could not reach ${c.baseUrl}. Check that the model server is running and allows requests from this page (CORS).`);
			}
			if (!res.ok) {
				const detail = await res.text().catch(() => '');
				lastError = new Error(`The model server answered ${res.status}: ${detail.slice(0, 240)}`);
				if (job.json && !this.mode && mode !== 'none' && [400, 415, 422, 500, 501].includes(res.status)) continue;
				throw lastError;
			}
			if (job.json && !this.mode && (job.schema || mode !== 'json_schema')) { this.mode = mode; this.post({ type: 'format', mode }); }
			if (job.stream && res.body) return this.readStream(res.body, job, usage, startedAt);
			const data: unknown = await res.json();
			readUsage(data, usage);
			const { content, reasoning } = messageParts(data);
			usage.answerChars = content.length + reasoning.length;
			return pickAnswer(content, reasoning, job.json);
		}
		throw lastError ?? new Error('The model request failed.');
	}

	private async readStream(body: ReadableStream<Uint8Array>, job: Job, usage: Usage, startedAt: number): Promise<string> {
		const key = job.key;
		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		let full = '';
		let thought = '';
		let last = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
				const line = buf.slice(0, i).trim();
				buf = buf.slice(i + 1);
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') continue;
				try {
					const data: unknown = JSON.parse(payload);
					readUsage(data, usage);
					const { content: delta, reasoning } = deltaParts(data);
					thought += reasoning;
					if (delta || reasoning) {
						if (usage.firstTokenMs === null) usage.firstTokenMs = Date.now() - startedAt;
						full += delta;
						usage.answerChars = full.length + thought.length;
						if (delta && Date.now() - last > 60) { last = Date.now(); this.post({ type: 'chunk', key, text: stripThinking(full) }); }
					}
				} catch { /* a partial line; the rest arrives with the next chunk */ }
			}
		}
		return pickAnswer(full, thought, job.json);
	}

}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null;
function firstChoice(data: unknown): Dict | null {
	if (!isDict(data) || !Array.isArray(data['choices'])) return null;
	const c: unknown = data['choices'][0];
	return isDict(c) ? c : null;
}
/** `content` and the reasoning a server split off it (`reasoning_content`, or `reasoning` in Ollama and vLLM). */
function parts(m: unknown): { content: string; reasoning: string } {
	if (!isDict(m)) return { content: '', reasoning: '' };
	const r = m['reasoning_content'] ?? m['reasoning'];
	return { content: typeof m['content'] === 'string' ? m['content'] : '', reasoning: typeof r === 'string' ? r : '' };
}
function messageParts(data: unknown): { content: string; reasoning: string } { return parts(firstChoice(data)?.['message']); }
function deltaParts(data: unknown): { content: string; reasoning: string } { return parts(firstChoice(data)?.['delta']); }
/** Token counts from an OpenAI-style `usage` object, when the server sends one. */
function readUsage(data: unknown, usage: Usage): void {
	const u = isDict(data) ? data['usage'] : null;
	if (!isDict(u)) return;
	if (typeof u['prompt_tokens'] === 'number') usage.promptTokens = u['prompt_tokens'];
	if (typeof u['completion_tokens'] === 'number') usage.completionTokens = u['completion_tokens'];
}
/** Model ids from an OpenAI-compatible `/models` response. */
export function modelIds(json: unknown): string[] {
	if (!isDict(json)) return [];
	const list: unknown = json['data'] ?? json['models'];
	if (!Array.isArray(list)) return [];
	return list.map((m: unknown) => (isDict(m) ? m['id'] ?? m['name'] ?? m['model'] : null)).filter((x): x is string => typeof x === 'string');
}
