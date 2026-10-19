import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Notifier } from '../../services/notifier';

/** The banner above the manuscript and the toast at the bottom of the window. */
@Component({
	selector: 'tl-notices',
	changeDetection: ChangeDetectionStrategy.OnPush,
	template: `
		@if (notifier.banner(); as b) {
			<div class="banner" role="alertdialog" aria-live="polite">
				<span class="grow">{{ b.text }}</span>
				@for (a of b.actions; track a.label; let first = $first) {
					<button type="button" class="btn" [class.primary]="first" (click)="notifier.answer(a)">{{ a.label }}</button>
				}
			</div>
		}
		@if (notifier.toast(); as t) { <div class="toast" role="status" aria-live="polite">{{ t.text }}</div> }
	`,
})
export class Notices {
	readonly notifier = inject(Notifier);
}
