/** Browser variant of the fixture loader, used by tools/browser-test. */
export async function fixture(name: string): Promise<Uint8Array<ArrayBuffer>> {
	const r = await fetch(`/test/fixtures/${name}`);
	if (!r.ok) throw new Error(`Fixture ${name}: HTTP ${r.status}`);
	return new Uint8Array(await r.arrayBuffer());
}
