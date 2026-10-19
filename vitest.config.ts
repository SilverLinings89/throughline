import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Core tests only. They need a DOM (XML parsing, the editor helpers), which jsdom provides.
export default defineConfig({
	resolve: { alias: { '#fixtures': fileURLToPath(new URL('./test/support/fixtures.node.ts', import.meta.url)) } },
	test: { environment: 'jsdom', include: ['test/**/*.spec.ts'] },
});
