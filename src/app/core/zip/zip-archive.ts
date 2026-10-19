import type { Bytes } from '../model';

/**
 * Minimal zip reader and writer for .docx and .odt packages.
 * Uses the platform's `CompressionStream`, so there is no third-party dependency.
 * Entries that are not replaced are copied as their original compressed bytes.
 */
type ZipEntry =
	| { readonly kind: 'original'; readonly raw: Bytes; readonly method: number; readonly crc: number; readonly size: number }
	| { readonly kind: 'replaced'; readonly data: Bytes };

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** CRC-32 as used by zip. */
export function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

async function transform(input: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
	const writer = stream.writable.getWriter();
	const written = writer.write(input).then(() => writer.close());
	const reader = stream.readable.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const r = await reader.read();
		if (r.done) break;
		chunks.push(r.value);
		size += r.value.length;
	}
	await written;
	const out = new Uint8Array(size);
	let at = 0;
	for (const c of chunks) { out.set(c, at); at += c.length; }
	return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ZipArchive {
	private readonly entries = new Map<string, ZipEntry>();

	/** Reads a zip package. Throws when the bytes are not a zip file. */
	static async open(bytes: Bytes): Promise<ZipArchive> {
		const zip = new ZipArchive();
		const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		let eocd = -1;
		for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
			if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
		}
		if (eocd < 0) throw new Error('This file is not a .docx or .odt package, or it is damaged.');
		const count = dv.getUint16(eocd + 10, true);
		let p = dv.getUint32(eocd + 16, true);
		for (let k = 0; k < count; k++) {
			if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('The file is damaged: its zip directory cannot be read.');
			const method = dv.getUint16(p + 10, true);
			const crc = dv.getUint32(p + 16, true);
			const csize = dv.getUint32(p + 20, true);
			const size = dv.getUint32(p + 24, true);
			const nameLen = dv.getUint16(p + 28, true);
			const extraLen = dv.getUint16(p + 30, true);
			const commentLen = dv.getUint16(p + 32, true);
			const offset = dv.getUint32(p + 42, true);
			const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
			p += 46 + nameLen + extraLen + commentLen;
			if (name.endsWith('/')) continue;
			const start = offset + 30 + dv.getUint16(offset + 26, true) + dv.getUint16(offset + 28, true);
			zip.entries.set(name, { kind: 'original', raw: bytes.subarray(start, start + csize), method, crc, size });
		}
		return zip;
	}

	has(name: string): boolean { return this.entries.has(name); }
	names(): string[] { return [...this.entries.keys()]; }

	/** Uncompressed bytes of an entry, or null when it does not exist. */
	async bytes(name: string): Promise<Bytes | null> {
		const e = this.entries.get(name);
		if (!e) return null;
		if (e.kind === 'replaced') return e.data;
		if (e.method === 0) return e.raw;
		if (e.method === 8) return transform(e.raw, new DecompressionStream('deflate-raw'));
		throw new Error(`Unsupported compression method ${e.method} in ${name}.`);
	}

	async text(name: string): Promise<string | null> {
		const b = await this.bytes(name);
		return b ? decoder.decode(b) : null;
	}

	set(name: string, data: string | Bytes): void {
		this.entries.set(name, { kind: 'replaced', data: typeof data === 'string' ? encoder.encode(data) : data });
	}

	delete(name: string): void { this.entries.delete(name); }

	/** Writes the package. `mimetype` goes first and uncompressed, as OpenDocument requires. */
	async build(): Promise<Bytes> {
		const names = this.names();
		const mi = names.indexOf('mimetype');
		if (mi > 0) { names.splice(mi, 1); names.unshift('mimetype'); }
		const parts: Uint8Array[] = [];
		const central: Uint8Array[] = [];
		let offset = 0;
		let count = 0;
		const d = new Date();
		const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
		const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
		for (const name of names) {
			const e = this.entries.get(name);
			if (!e) continue;
			let raw: Uint8Array, method: number, crc: number, size: number;
			if (e.kind === 'replaced' || name === 'mimetype') {
				const data = e.kind === 'replaced' ? e.data : await this.bytes(name);
				if (!data) continue;
				size = data.length;
				crc = crc32(data);
				if (name === 'mimetype' || size < 80) { method = 0; raw = data; }
				else { method = 8; raw = await transform(data, new CompressionStream('deflate-raw')); }
			} else {
				({ raw, method, crc, size } = e);
			}
			const nameBytes = encoder.encode(name);
			const lh = new DataView(new ArrayBuffer(30));
			lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, method, true);
			lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
			lh.setUint32(18, raw.length, true); lh.setUint32(22, size, true); lh.setUint16(26, nameBytes.length, true);
			parts.push(new Uint8Array(lh.buffer), nameBytes, raw);
			const ch = new DataView(new ArrayBuffer(46));
			ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
			ch.setUint16(10, method, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
			ch.setUint32(20, raw.length, true); ch.setUint32(24, size, true); ch.setUint16(28, nameBytes.length, true); ch.setUint32(42, offset, true);
			central.push(new Uint8Array(ch.buffer), nameBytes);
			offset += 30 + nameBytes.length + raw.length;
			count++;
		}
		const cdSize = central.reduce((a, c) => a + c.length, 0);
		const end = new DataView(new ArrayBuffer(22));
		end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true);
		end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
		const all = [...parts, ...central, new Uint8Array(end.buffer)];
		const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
		let at = 0;
		for (const c of all) { out.set(c, at); at += c.length; }
		return out;
	}
}
