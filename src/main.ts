import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { log } from './app/core/util/log';

bootstrapApplication(App, appConfig).catch((err: unknown) => log.error('bootstrap-failed', { error: String(err) }));
