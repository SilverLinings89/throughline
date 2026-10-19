import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { droppedFileHandle } from './core/platform';
import { AiClient } from './services/ai-client';
import { AnalysisService } from './services/analysis.service';
import { DocumentStore } from './services/document.store';
import { DraftService } from './services/drafts.service';
import { EditorService, LAYERS } from './services/editor.service';
import { FilesService } from './services/files.service';
import { PwaService } from './services/pwa.service';
import { SettingsStore } from './services/settings.store';
import { UiState } from './services/ui-state';
import { EditorSurface } from './ui/editor/editor-surface';
import { LensPanel } from './ui/lens/lens-panel';
import { MapPanel } from './ui/map/map-panel';
import { Notices } from './ui/notices/notices';
import { SettingsDialog } from './ui/settings/settings-dialog';
import { TopBar } from './ui/topbar/top-bar';

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** App shell: layout, shortcuts, drag and drop, theme, and start-up. */
@Component({
	selector: 'tl-root',
	changeDetection: ChangeDetectionStrategy.OnPush,
	imports: [MapPanel, TopBar, Notices, EditorSurface, LensPanel, SettingsDialog],
	templateUrl: './app.html',
	host: {
		'[class.map-closed]': '!mapVisible()',
		'[class.zen]': 'zen()',
		'[class.lens-open]': 'editor.lensOpen()',
		'(document:keydown)': 'onKey($event)',
		'(window:focus)': 'files.checkExternal()',
		'(window:beforeunload)': 'onBeforeUnload($event)',
		'(window:resize)': 'onResize()',
		'(window:dragenter)': 'onDrag($event, 1)',
		'(window:dragleave)': 'onDrag($event, -1)',
		'(window:dragover)': 'onDragOver($event)',
		'(window:drop)': 'onDrop($event)',
	},
})
export class App {
	readonly editor = inject(EditorService);
	readonly files = inject(FilesService);
	readonly ui = inject(UiState);
	private readonly settings = inject(SettingsStore);
	private readonly docs = inject(DocumentStore);
	private readonly drafts = inject(DraftService);
	private readonly pwa = inject(PwaService);
	private readonly ai = inject(AiClient);
	private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
	private dragDepth = 0;
	readonly dragging = signal(false);

	readonly zen = computed(() => this.settings.editor().zen);
	readonly mapVisible = computed(() => (this.ui.narrow() ? this.ui.mapOverlayOpen() : this.settings.editor().mapOpen && !this.zen()));

	constructor() {
		inject(AnalysisService);
		effect(() => {
			const e = this.settings.editor();
			const root = document.documentElement;
			root.style.setProperty('--fs', `${e.fontSize}px`);
			root.style.setProperty('--measure', `${e.measure}em`);
			root.style.setProperty('--dim', e.focus === 'strong' ? '.13' : '.32');
			if (e.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset['theme'] = e.theme;
		});
		effect(() => { document.title = `${this.editor.title()} | Throughline`; });
		afterNextRender(() => {
			this.files.fileInput = this.fileInput().nativeElement;
			this.pwa.start();
			this.ai.probe();
			void this.drafts.offer();
		});
	}

	onFileChosen(input: HTMLInputElement): void {
		const f = input.files?.[0];
		input.value = '';
		if (f) void this.files.open(f, null);
	}

	onKey(e: KeyboardEvent): void {
		const mod = IS_MAC ? e.metaKey : e.ctrlKey;
		const k = e.key.toLowerCase();
		if (mod && !e.altKey && k === 's') { e.preventDefault(); void this.files.save(); }
		else if (mod && !e.shiftKey && !e.altKey && k === 'o') { e.preventDefault(); void this.files.pick(); }
		else if (mod && !e.altKey && e.key === '.') { e.preventDefault(); this.editor.lensOpen.update(v => !v); }
		else if (mod && !e.altKey && e.code === 'Backslash') { e.preventDefault(); this.ui.toggleMap(); }
		else if (mod && e.shiftKey && !e.altKey && e.code === 'KeyF') { e.preventDefault(); this.ui.toggleZen(); }
		else if (mod && !e.shiftKey && !e.altKey && k === 'k' && document.activeElement?.classList.contains('ed')) {
			e.preventDefault();
			const url = prompt('Link address (leave empty to remove the link)', this.editor.currentLink() ?? 'https://');
			if (url !== null) this.editor.setLink(url === 'https://' ? '' : url);
		}
		else if (e.ctrlKey && e.shiftKey && !e.altKey && /^Digit[1-4]$/.test(e.code)) { e.preventDefault(); this.editor.setLayer(LAYERS[Number(e.code.slice(5)) - 1]); }
		else if (e.key === 'Escape' && this.ui.settingsTab() === null && this.editor.lensOpen()) { this.editor.lensOpen.set(false); this.editor.refocus(); }
	}

	onMainPointer(): void { if (this.ui.narrow() && this.ui.mapOverlayOpen()) this.ui.mapOverlayOpen.set(false); }
	onResize(): void { this.ui.narrow.set(matchMedia('(max-width: 899px)').matches); }

	onBeforeUnload(e: BeforeUnloadEvent): void {
		if (!this.docs.dirty()) return;
		void this.drafts.save();
		e.preventDefault();
	}

	private hasFiles(e: DragEvent): boolean { return !!e.dataTransfer?.types.includes('Files'); }
	onDrag(e: DragEvent, step: 1 | -1): void {
		if (step === 1 && !this.hasFiles(e)) return;
		this.dragDepth = Math.max(0, this.dragDepth + step);
		this.dragging.set(this.dragDepth > 0);
	}
	onDragOver(e: DragEvent): void { if (this.hasFiles(e)) e.preventDefault(); }
	async onDrop(e: DragEvent): Promise<void> {
		const file = e.dataTransfer?.files[0];
		if (!file) return;
		e.preventDefault();
		this.dragDepth = 0;
		this.dragging.set(false);
		const item = e.dataTransfer?.items[0];
		await this.files.open(file, item ? await droppedFileHandle(item) : null);
	}
}
