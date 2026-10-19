import { readFile } from 'node:fs/promises';

/** Reads a file from `test/fixtures`. */
export async function fixture(name: string): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await readFile(new URL(`../fixtures/${name}`, import.meta.url)));
}
