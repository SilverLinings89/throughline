/// <reference lib="webworker" />
import { AiEngine } from '../core/ai/engine';
import type { WorkerCommand } from '../core/ai/protocol';

const engine = new AiEngine(e => postMessage(e));
addEventListener('message', (e: MessageEvent<WorkerCommand>) => engine.handle(e.data));
