/** Places a reading's issues in the current text of a paragraph. */
import { hash } from '../util/hash';
import { findQuote, quoteLength } from '../text/text';
import type { Issue } from './readings';

export interface LocatedIssue extends Issue {
	/** Stable id: the same issue keeps its id when the paragraph is edited elsewhere. */
	readonly id: string;
	readonly start: number;
	readonly end: number;
}

export const issueId = (i: Issue): string => hash(`${i.type}|${i.quote}|${i.suggestion}`);

/** Issues whose quote is still in `text`, minus ignored and applied ones. */
export function locateIssues(text: string, issues: readonly Issue[], hidden: ReadonlySet<string>): LocatedIssue[] {
	const out: LocatedIssue[] = [];
	for (const issue of issues) {
		const id = issueId(issue);
		if (hidden.has(id)) continue;
		const start = findQuote(text, issue.quote);
		if (start < 0) continue;
		out.push({ ...issue, id, start, end: start + quoteLength(text, start, issue.quote) });
	}
	return out;
}
