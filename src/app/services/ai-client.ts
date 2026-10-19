import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AiEngine, modelIds } from '../core/ai/engine';
import { parseMetrics, type RequestMetric } from '../core/ai/metrics';
import type { Job, JobKind, RunningJob, TestResult, WorkerCommand, WorkerEvent } from '../core/ai/protocol';
import { parseReading, type Reading } from '../core/analysis/readings';
import { SettingsStore } from './settings.store';

export interface ChatHandlers {
	readonly chunk: (text: string) => void;
	readonly done: (text: string) => void;
	readonly fail: (error: string) => void;
}
type ResultHandler = (key: string, reading: Reading) => void;
type FailHandler = (key: string) => void;

const METRICS_KEY = 'throughline.metrics';
/** Requests kept for the Usage tab. Older ones are dropped. */
const METRICS_LIMIT = 3000;

function loadMetrics(): RequestMetric[] {
	try { return parseMetrics(JSON.parse(localStorage.getItem(METRICS_KEY) ?? '[]')); } catch { return []; }
}

/**
 * Bridge to the AI worker. Owns the worker, mirrors its status in signals,
 * validates readings at the boundary and tracks failures: a timeout or an unusable answer is not
 * repeated for the same text, other errors back off exponentially.
 */
@Injectable({ providedIn: 'root' })
export class AiClient {
	private readonly settings = inject(SettingsStore);
	private send!: (cmd: WorkerCommand) => void;
	private readonly results = new Set<ResultHandler>();
	private readonly failures = new Set<FailHandler>();
	private readonly chats = new Map<string, ChatHandlers>();
	private lastHold = 0;
	private readonly backoff = new Map<string, { n: number; until: number }>();

	/** Keys sent to the worker and not yet answered, with their priority. */
	readonly pending = new Map<string, number>();
	readonly queued = signal(0);
	readonly running = signal<readonly RunningJob[]>([]);
	readonly offline = signal(false);
	readonly lastError = signal('');
	/** Every measured request, oldest first, across sessions. */
	readonly metrics = signal<readonly RequestMetric[]>(loadMetrics());
	/** When this session began; the Usage tab can show only requests since then. */
	readonly sessionStart = Date.now();
	private metricsTimer: ReturnType<typeof setTimeout> | undefined;
	readonly ready = computed(() => { const a = this.settings.ai(); return a.enabled && !!a.baseUrl && !!a.model; });

	constructor() {
		const receive = (e: WorkerEvent): void => this.receive(e);
		try {
			const worker = new Worker(new URL('../workers/ai.worker', import.meta.url), { type: 'module' });
			worker.onmessage = (e: MessageEvent<WorkerEvent>) => receive(e.data);
			this.send = cmd => worker.postMessage(cmd);
		} catch {
			// No module workers: run the same engine on this thread. Requests stay asynchronous.
			const engine = new AiEngine(e => setTimeout(() => receive(e)));
			this.send = cmd => setTimeout(() => engine.handle(cmd));
		}
		effect(() => {
			const a = this.settings.ai();
			untracked(() => {
				this.send({ type: 'config', config: { baseUrl: a.baseUrl, model: a.model, apiKey: a.apiKey, temperature: a.temperature, concurrency: Math.max(1, a.concurrency), structured: a.structured, timeoutSec: a.timeoutSec, maxTokens: a.maxTokens } });
				this.backoff.clear();
				this.offline.set(false);
				this.lastError.set('');
			});
		});
	}

	/** Contacts the server once from the page so a hosted app can ask for local network access early. */
	probe(): void {
		const a = this.settings.ai();
		if (a.enabled && a.baseUrl && a.model) void this.test(a.baseUrl, a.apiKey).then(r => { if (!r.ok) { this.offline.set(true); this.lastError.set(r.error); } });
	}

	onResult(handler: ResultHandler): void { this.results.add(handler); }
	onFailure(handler: FailHandler): void { this.failures.add(handler); }

	enqueue(jobs: readonly Job[]): void {
		if (!jobs.length) return;
		for (const j of jobs) this.pending.set(j.key, j.priority);
		this.send({ type: 'enqueue', jobs });
	}
	reprioritize(list: readonly (readonly [string, number])[]): void {
		if (!list.length) return;
		for (const [k, p] of list) this.pending.set(k, p);
		this.send({ type: 'priority', list });
	}
	cancel(keys: readonly string[]): void {
		if (!keys.length) return;
		for (const k of keys) this.pending.delete(k);
		this.send({ type: 'cancel', keys });
	}
	clear(): void { this.pending.clear(); this.send({ type: 'clear' }); }

	/** Pauses new requests for a moment. Called on every keystroke, sends at most every 700 ms. */
	hold(): void {
		if (!this.settings.ai().pauseWhileTyping) return;
		const now = Date.now();
		if (now - this.lastHold < 700) return;
		this.lastHold = now;
		this.send({ type: 'hold', ms: 2200 });
	}

	/** True while a key is in backoff after failures, after four failures in a row, or after a timeout or unusable answer. */
	blocked(key: string): boolean {
		const b = this.backoff.get(key);
		return !!b && (b.n >= 4 || b.until > Date.now());
	}
	forgive(key: string): void { this.backoff.delete(key); }

	/**
	 * Lists the server's models. Runs on the page's own thread, not in the worker: Chrome asks for
	 * "local network access" only for requests from a page, and a granted permission then also
	 * covers the worker's requests.
	 */
	async test(baseUrl: string, apiKey: string): Promise<TestResult> {
		try {
			const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
			if (!r.ok) return { ok: false, error: `The server answered ${r.status}.` };
			return { ok: true, models: modelIds(await r.json()) };
		} catch {
			return { ok: false, error: `Could not reach ${baseUrl}. Is the server running, and does it allow requests from this page (CORS)?` };
		}
	}

	clearMetrics(): void {
		this.metrics.set([]);
		try { localStorage.removeItem(METRICS_KEY); } catch { /* storage unavailable */ }
	}

	private record(m: RequestMetric): void {
		this.metrics.update(list => (list.length >= METRICS_LIMIT ? [...list.slice(list.length - METRICS_LIMIT + 1), m] : [...list, m]));
		this.storeMetricsSoon();
	}

	private storeMetricsSoon(): void {
		clearTimeout(this.metricsTimer);
		this.metricsTimer = setTimeout(() => {
			try { localStorage.setItem(METRICS_KEY, JSON.stringify(this.metrics())); } catch { /* private mode or full storage */ }
		}, 2000);
	}

	/** Marks the latest measurement of `key` as unusable, when its answer failed validation here. */
	private markInvalid(key: string): void {
		const list = this.metrics();
		for (let i = list.length - 1; i >= 0; i--) {
			if (list[i].key !== key) continue;
			if (list[i].outcome === 'ok') { this.metrics.set(list.map((m, k): RequestMetric => (k === i ? { ...m, outcome: 'invalid' } : m))); this.storeMetricsSoon(); }
			return;
		}
	}

	chat(key: string, job: Job, handlers: ChatHandlers): void {
		this.chats.set(key, handlers);
		this.enqueue([job]);
	}

	private receive(e: WorkerEvent): void {
		switch (e.type) {
			case 'status': this.queued.set(e.queued); this.running.set(e.running); break;
			case 'format': break;
			case 'metric': this.record(e.metric); break;
			case 'chunk': this.chats.get(e.key)?.chunk(e.text); break;
			case 'done': {
				this.pending.delete(e.key);
				if (e.kind === 'chat') { this.chats.get(e.key)?.done(typeof e.result === 'string' ? e.result : ''); this.chats.delete(e.key); break; }
				const reading = parseReading(readingKind(e.kind), e.result);
				if (!reading) { this.markInvalid(e.key); this.fail(e.key, 'The model returned an answer in an unexpected shape.', true); break; }
				this.offline.set(false);
				this.lastError.set('');
				this.backoff.delete(e.key);
				for (const h of this.results) h(e.key, reading);
				break;
			}
			case 'error':
				this.pending.delete(e.key);
				if (e.kind === 'chat') { this.chats.get(e.key)?.fail(e.error); this.chats.delete(e.key); }
				if (e.reason !== 'cancelled') this.fail(e.key, e.error, e.reason === 'timeout' || e.reason === 'invalid');
				for (const h of this.failures) h(e.key);
				break;
			default: { const exhaustive: never = e; return exhaustive; }
		}
	}

	/** `final`: the same request would fail the same way, so it is not repeated until the text changes or the author asks. */
	private fail(key: string, error: string, final = false): void {
		const b = this.backoff.get(key) ?? { n: 0, until: 0 };
		const n = final ? 4 : b.n + 1;
		this.backoff.set(key, { n, until: Date.now() + Math.min(30 * 60e3, 20e3 * 2 ** n) });
		this.lastError.set(error);
		this.offline.set(/Could not reach/.test(error));
	}
}

function readingKind(kind: JobKind): 'para' | 'section' | 'doc' {
	return kind === 'section' ? 'section' : kind === 'doc' ? 'doc' : 'para';
}
