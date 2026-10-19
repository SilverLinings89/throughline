import { Injectable, effect, signal } from '@angular/core';
import type { StructuredMode } from '../core/ai/protocol';

/** Model connection and background reading. Stored per browser, not per document. */
export interface AiSettings {
	readonly enabled: boolean;
	readonly baseUrl: string;
	readonly model: string;
	readonly apiKey: string;
	readonly temperature: number;
	readonly concurrency: number;
	readonly structured: StructuredMode;
	readonly timeoutSec: number;
	/** Characters of section text per request. */
	readonly budget: number;
	readonly maxTokens: number;
	readonly pauseWhileTyping: boolean;
	/** Seconds to wait before reading the paragraph the cursor is in. */
	readonly paraDelaySec: number;
}
export interface EditorSettings {
	readonly focus: 'soft' | 'strong';
	readonly typewriter: boolean;
	readonly fontSize: number;
	readonly measure: number;
	readonly theme: 'auto' | 'light' | 'dark';
	readonly gutter: boolean;
	/** Store readings and document settings inside saved files. */
	readonly embed: boolean;
	readonly mapOpen: boolean;
	readonly deskFolded: boolean;
	/** Both side panels folded away, for writing without distraction. */
	readonly zen: boolean;
	/** Let the browser mark spelling mistakes in the text. */
	readonly spellcheck: boolean;
}

export const DEFAULT_AI: AiSettings = { enabled: true, baseUrl: 'http://localhost:11434/v1', model: '', apiKey: '', temperature: 0.2, concurrency: 1, structured: 'auto', timeoutSec: 240, budget: 12000, maxTokens: 0, pauseWhileTyping: true, paraDelaySec: 4 };
export const DEFAULT_EDITOR: EditorSettings = { focus: 'soft', typewriter: true, fontSize: 20, measure: 34, theme: 'auto', gutter: true, embed: true, mapOpen: true, deskFolded: false, zen: false, spellcheck: true };

const KEY = 'throughline.settings';

function load(): { ai: AiSettings; editor: EditorSettings } {
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		const obj = typeof raw === 'object' && raw !== null ? raw : {};
		const ai = 'ai' in obj && typeof obj.ai === 'object' ? obj.ai : {};
		const editor = 'editor' in obj && typeof obj.editor === 'object' ? obj.editor : {};
		return { ai: { ...DEFAULT_AI, ...ai }, editor: { ...DEFAULT_EDITOR, ...editor } };
	} catch {
		return { ai: DEFAULT_AI, editor: DEFAULT_EDITOR };
	}
}

/** App-wide preferences, persisted to localStorage on every change. */
@Injectable({ providedIn: 'root' })
export class SettingsStore {
	private readonly initial = load();
	readonly ai = signal<AiSettings>(this.initial.ai);
	readonly editor = signal<EditorSettings>(this.initial.editor);

	constructor() {
		effect(() => {
			const value = { ai: this.ai(), editor: this.editor() };
			try { localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* private mode or full storage */ }
		});
	}

	updateAi(patch: Partial<AiSettings>): void { this.ai.update(a => ({ ...a, ...patch })); }
	updateEditor(patch: Partial<EditorSettings>): void { this.editor.update(e => ({ ...e, ...patch })); }
}
