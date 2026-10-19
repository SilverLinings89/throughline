/** Messages between the app and the AI worker. Plain, structured-cloneable data only. */
import type { ChatMessage } from '../analysis/prompts';
import type { RequestMetric } from './metrics';

export type StructuredMode = 'auto' | 'json_schema' | 'json_object' | 'none';
export type ResolvedMode = Exclude<StructuredMode, 'auto'>;
export type JobKind = 'para' | 'section' | 'doc' | 'chat';

/** Jobs at or above this priority start even while the user types. They never interrupt running work. */
export const URGENT = 1000;

export interface AiConfig {
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey: string;
	readonly temperature: number;
	readonly concurrency: number;
	readonly structured: StructuredMode;
	readonly timeoutSec: number;
	/** 0 leaves the answer length to the server. */
	readonly maxTokens: number;
}

export interface Job {
	readonly key: string;
	readonly kind: JobKind;
	priority: number;
	readonly label: string;
	readonly messages: readonly ChatMessage[];
	readonly json: boolean;
	readonly schema?: object;
	readonly stream?: boolean;
	readonly temperature?: number;
	/** Answer length limit for this job; the configured `maxTokens` wins when it is set. */
	readonly maxTokens?: number;
}

/** Why a job failed: a timeout or an unusable answer is not worth repeating for the same text. */
export type FailReason = 'timeout' | 'invalid' | 'cancelled' | 'error';

export interface RunningJob { readonly key: string; readonly kind: JobKind; readonly label: string }

export type WorkerCommand =
	| { readonly type: 'config'; readonly config: AiConfig }
	| { readonly type: 'enqueue'; readonly jobs: readonly Job[] }
	| { readonly type: 'priority'; readonly list: readonly (readonly [string, number])[] }
	| { readonly type: 'cancel'; readonly keys: readonly string[] }
	| { readonly type: 'hold'; readonly ms: number }
	| { readonly type: 'clear' };

export type TestResult = { readonly ok: true; readonly models: string[] } | { readonly ok: false; readonly error: string };

export type WorkerEvent =
	| { readonly type: 'status'; readonly queued: number; readonly running: readonly RunningJob[] }
	| { readonly type: 'format'; readonly mode: ResolvedMode }
	| { readonly type: 'chunk'; readonly key: string; readonly text: string }
	/** Sent once per finished, failed or dropped job, before its `done` or `error`. */
	| { readonly type: 'metric'; readonly metric: RequestMetric }
	| { readonly type: 'done'; readonly key: string; readonly kind: JobKind; readonly result: unknown }
	| { readonly type: 'error'; readonly key: string; readonly kind: JobKind; readonly error: string; readonly reason: FailReason };
