import { Injectable, signal } from '@angular/core';

export interface Toast { readonly id: number; readonly text: string }
export interface BannerAction { readonly label: string; readonly run: () => void }
export interface Banner { readonly text: string; readonly actions: readonly BannerAction[] }

/** Short messages (toasts) and messages that need an answer (banners). */
@Injectable({ providedIn: 'root' })
export class Notifier {
	readonly toast = signal<Toast | null>(null);
	readonly banner = signal<Banner | null>(null);
	private timer: ReturnType<typeof setTimeout> | undefined;

	say(text: string, ms = 3200): void {
		const id = Date.now();
		this.toast.set({ id, text });
		clearTimeout(this.timer);
		this.timer = setTimeout(() => { if (this.toast()?.id === id) this.toast.set(null); }, ms);
	}

	ask(text: string, actions: readonly BannerAction[]): void { this.banner.set({ text, actions }); }
	answer(action: BannerAction): void { this.banner.set(null); action.run(); }
}
