import type { Block, SaveBlock } from '../../src/app/core/model';

/** Marks every block unchanged, as the editor does for a document nobody touched. */
export const asUnchanged = (blocks: readonly Block[]): SaveBlock[] => blocks.map(b => ({ ...b, unchanged: true }));

/** Plain text of a block, for assertions. */
export const textOf = (b: Block): string => (b.type === 'opaque' ? `[${b.label}]` : b.runs.map(r => (r.kind === 'text' ? r.t : `[note ${r.label}]`)).join(''));
