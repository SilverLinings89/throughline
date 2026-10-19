/**
 * Measurements of model requests, and the summaries the Usage tab shows. Plain data, no Angular:
 * the engine produces one `RequestMetric` per job, the app keeps them, this file sums them up.
 */
import type { JobKind } from './protocol';

export type MetricOutcome = 'ok' | 'invalid' | 'error' | 'timeout' | 'cancelled' | 'preempted';

export interface RequestMetric {
	/** When the request started (ms since epoch). */
	readonly at: number;
	readonly key: string;
	readonly kind: JobKind;
	readonly model: string;
	/** Time the job waited in the queue before it started. */
	readonly waitMs: number;
	/** Time from the start of the first HTTP request to the end of the answer, retries included. */
	readonly ms: number;
	/** Time to the first streamed piece of the answer, for streamed jobs. */
	readonly firstTokenMs: number | null;
	readonly promptTokens: number;
	readonly completionTokens: number;
	/** True when the server reported no usage and the token counts are estimated from characters. */
	readonly estimated: boolean;
	/** HTTP requests made, more than one while the engine finds out which answer format works. */
	readonly attempts: number;
	readonly outcome: MetricOutcome;
}

/** Rough tokens for a text when the server does not say: about four characters per token. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

export interface MetricSummary {
	readonly requests: number;
	readonly ok: number;
	/** Answers that arrived but could not be used: not JSON, or the wrong shape. */
	readonly invalid: number;
	readonly failed: number;
	readonly timeouts: number;
	/** Cancelled or pre-empted: work thrown away because the text changed or something was more urgent. */
	readonly dropped: number;
	readonly medianMs: number | null;
	readonly p90Ms: number | null;
	readonly medianWaitMs: number | null;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly avgPromptTokens: number | null;
	readonly avgCompletionTokens: number | null;
	/** Answer tokens per second over successful requests, prompt processing included. */
	readonly tokensPerSec: number | null;
	readonly estimated: boolean;
}

function percentile(sorted: readonly number[], p: number): number | null {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[i];
}

export function summarize(list: readonly RequestMetric[]): MetricSummary {
	const answered = list.filter(m => m.outcome === 'ok' || m.outcome === 'invalid');
	const times = answered.map(m => m.ms).sort((a, b) => a - b);
	const waits = list.filter(m => m.outcome !== 'preempted').map(m => m.waitMs).sort((a, b) => a - b);
	const promptTokens = list.reduce((n, m) => n + m.promptTokens, 0);
	const completionTokens = list.reduce((n, m) => n + m.completionTokens, 0);
	const okList = list.filter(m => m.outcome === 'ok');
	const okMs = okList.reduce((n, m) => n + m.ms, 0);
	const okTokens = okList.reduce((n, m) => n + m.completionTokens, 0);
	return {
		requests: list.length,
		ok: okList.length,
		invalid: list.filter(m => m.outcome === 'invalid').length,
		failed: list.filter(m => m.outcome === 'error' || m.outcome === 'timeout').length,
		timeouts: list.filter(m => m.outcome === 'timeout').length,
		dropped: list.filter(m => m.outcome === 'cancelled' || m.outcome === 'preempted').length,
		medianMs: percentile(times, 0.5),
		p90Ms: percentile(times, 0.9),
		medianWaitMs: percentile(waits, 0.5),
		promptTokens,
		completionTokens,
		avgPromptTokens: answered.length ? Math.round(answered.reduce((n, m) => n + m.promptTokens, 0) / answered.length) : null,
		avgCompletionTokens: answered.length ? Math.round(answered.reduce((n, m) => n + m.completionTokens, 0) / answered.length) : null,
		tokensPerSec: okMs > 0 ? okTokens / (okMs / 1000) : null,
		estimated: list.some(m => m.estimated),
	};
}

/** Groups metrics by a key, keeping first-seen order. */
export function groupBy<K extends string>(list: readonly RequestMetric[], key: (m: RequestMetric) => K): Map<K, RequestMetric[]> {
	const out = new Map<K, RequestMetric[]>();
	for (const m of list) { const k = key(m); const g = out.get(k); if (g) g.push(m); else out.set(k, [m]); }
	return out;
}

/**
 * Plain-language hints on whether a smaller or larger model fits better, from paragraph readings
 * (the most frequent and most time-sensitive requests) and the share of unusable answers.
 * `paraDelaySec` is how long the editor waits before reading the paragraph you are in.
 */
export function advice(list: readonly RequestMetric[], paraDelaySec: number): string[] {
	const out: string[] = [];
	const all = summarize(list);
	if (all.requests < 5) return ['Too few requests yet to judge. Write for a while with the model on, then look again.'];
	const para = summarize(list.filter(m => m.kind === 'para'));
	const answered = all.ok + all.invalid;
	const badShare = answered ? all.invalid / answered : 0;
	const failShare = all.requests ? all.failed / all.requests : 0;
	const slow = para.medianMs !== null && para.medianMs > Math.max(25e3, paraDelaySec * 5e3);
	const fast = para.medianMs !== null && para.medianMs < 8e3;
	if (slow) out.push(`A paragraph takes ${seconds(para.medianMs)} to read (median). Feedback arrives well after you have moved on; a smaller or more quantized model would keep up better.`);
	if (all.timeouts) out.push(`${all.timeouts} request${all.timeouts === 1 ? '' : 's'} hit the time limit. Use a smaller model, raise the time limit, or lower the text per section request.`);
	if (badShare >= 0.1) out.push(`${Math.round(badShare * 100)} % of answers could not be used. Small models often break the answer format; a larger model, or the JSON schema setting, usually fixes this.`);
	else if (fast && failShare < 0.05) out.push(`Paragraphs are read in ${seconds(para.medianMs)} and almost every answer is usable. There is room for a larger model if you want sharper feedback.`);
	if (!out.length) out.push('Speed and answer quality look balanced for this model.');
	if (all.dropped > all.requests * 0.3) out.push(`${all.dropped} of ${all.requests} requests were dropped because the text changed or something more urgent came first. A longer wait before reading (Model tab) saves that work.`);
	return out;
}

export function seconds(ms: number | null): string {
	if (ms === null) return '–';
	return ms < 10e3 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Metrics as CSV, one row per request. */
export function toCsv(list: readonly RequestMetric[]): string {
	const head = 'started,kind,model,outcome,wait_ms,duration_ms,first_token_ms,prompt_tokens,completion_tokens,estimated,attempts';
	const rows = list.map(m => [new Date(m.at).toISOString(), m.kind, JSON.stringify(m.model), m.outcome, m.waitMs, m.ms, m.firstTokenMs ?? '', m.promptTokens, m.completionTokens, m.estimated, m.attempts].join(','));
	return [head, ...rows].join('\n');
}

const KINDS: readonly JobKind[] = ['para', 'section', 'doc', 'chat'];
const OUTCOMES: readonly MetricOutcome[] = ['ok', 'invalid', 'error', 'timeout', 'cancelled', 'preempted'];
const isKind = (v: unknown): v is JobKind => KINDS.some(k => k === v);
const isOutcome = (v: unknown): v is MetricOutcome => OUTCOMES.some(o => o === v);
const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Validates metrics read back from storage; drops anything malformed. */
export function parseMetrics(raw: unknown): RequestMetric[] {
	if (!Array.isArray(raw)) return [];
	const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	const out: RequestMetric[] = [];
	for (const r of raw) {
		if (!isDict(r)) continue;
		const kind = r['kind'];
		const outcome = r['outcome'];
		if (!isKind(kind) || !isOutcome(outcome)) continue;
		out.push({
			at: num(r['at']), key: typeof r['key'] === 'string' ? r['key'] : '', kind, model: typeof r['model'] === 'string' ? r['model'] : '',
			waitMs: num(r['waitMs']), ms: num(r['ms']), firstTokenMs: typeof r['firstTokenMs'] === 'number' ? r['firstTokenMs'] : null,
			promptTokens: num(r['promptTokens']), completionTokens: num(r['completionTokens']), estimated: r['estimated'] === true,
			attempts: num(r['attempts']) || 1, outcome,
		});
	}
	return out;
}
