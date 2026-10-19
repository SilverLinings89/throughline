import { Injectable, inject } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';
import { isFileHandle, launchQueue } from '../core/platform';
import { FilesService } from './files.service';
import { Notifier } from './notifier';

/**
 * Installed-app behaviour: tells the user when a new version is ready, and opens files
 * passed in by the operating system ("Open with Throughline"), declared in the manifest.
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
	private readonly updates = inject(SwUpdate);
	private readonly files = inject(FilesService);
	private readonly notifier = inject(Notifier);

	start(): void {
		if (this.updates.isEnabled) {
			this.updates.versionUpdates.subscribe(e => {
				if (e.type !== 'VERSION_READY') return;
				this.notifier.ask('A new version of Throughline is ready.', [
					{ label: 'Reload now', run: () => location.reload() },
					{ label: 'Later', run: () => undefined },
				]);
			});
			this.updates.unrecoverable.subscribe(() => {
				this.notifier.ask('Throughline needs to reload to finish an update.', [{ label: 'Reload', run: () => location.reload() }]);
			});
		}
		launchQueue()?.setConsumer(params => {
			const handle = params.files.find(isFileHandle);
			if (handle) void handle.getFile().then(f => this.files.open(f, handle));
		});
	}
}
