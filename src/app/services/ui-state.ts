import { Injectable, inject, signal } from '@angular/core';
import { EditorService } from './editor.service';
import { SettingsStore } from './settings.store';

export type DeskTab = 'line' | 'notes' | 'ask';
export type SettingsTab = 'doc' | 'ai' | 'usage' | 'editor';
export interface ChatEntry { readonly role: 'user' | 'assistant'; text: string; pending: boolean; failed: boolean }

/** Interface state shared by several components. */
@Injectable({ providedIn: 'root' })
export class UiState {
	private readonly settings = inject(SettingsStore);
	private readonly editor = inject(EditorService);

	readonly deskTab = signal<DeskTab>('line');
	/** The open settings tab, or null when the dialog is closed. */
	readonly settingsTab = signal<SettingsTab | null>(null);
	readonly chat = signal<readonly ChatEntry[]>([]);
	/** True on screens narrower than 900px, where the map is an overlay. */
	readonly narrow = signal(typeof matchMedia === 'function' && matchMedia('(max-width: 899px)').matches);
	readonly mapOverlayOpen = signal(false);

	openSettings(tab: SettingsTab = 'doc'): void { this.settingsTab.set(tab); }

	/**
	 * Focus mode folds away the map and the lens. Opening the map leaves it; the lens can still be
	 * opened for a look (Ctrl+. or a click in the margin) and closed again without leaving.
	 */
	toggleZen(): void {
		const zen = !this.settings.editor().zen;
		this.settings.updateEditor({ zen });
		if (zen) { this.editor.lensOpen.set(false); this.mapOverlayOpen.set(false); }
		this.editor.refocus();
	}

	toggleMap(): void {
		if (this.narrow()) { this.mapOverlayOpen.update(v => !v); return; }
		const e = this.settings.editor();
		if (e.zen) this.settings.updateEditor({ zen: false, mapOpen: true });
		else this.settings.updateEditor({ mapOpen: !e.mapOpen });
	}

	toggleLens(): void { this.editor.lensOpen.update(v => !v); }

}
