import { createStore } from "zustand/vanilla";
import {
	commands,
	type PoolPaper,
	type PoolSnapshot,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import type { PaperMetadata } from "@/lib/paper/types";

type PoolState = {
	source: string | null;
	snapshot: PoolSnapshot | null;
	loading: boolean;
	error: string | null;
};
export const paperPoolStore = createStore<PoolState>(() => ({
	source: null,
	snapshot: null,
	loading: false,
	error: null,
}));
let generation = 0;
let pending: { source: string; promise: Promise<PoolSnapshot> } | null = null;

export function refreshPaperPool(source: string): Promise<PoolSnapshot> {
	if (pending?.source === source) return pending.promise;
	const token = ++generation;
	const previous = paperPoolStore.getState();
	paperPoolStore.setState({
		source,
		snapshot: previous.source === source ? previous.snapshot : null,
		loading: true,
		error: null,
	});
	const promise = callApi(() => commands.paperPoolRead(source))
		.then((snapshot) => {
			if (token === generation)
				paperPoolStore.setState({ snapshot, error: null });
			return snapshot;
		})
		.catch((error) => {
			if (token === generation)
				paperPoolStore.setState({ error: errorText(error) });
			throw error;
		})
		.finally(() => {
			if (token === generation) {
				pending = null;
				paperPoolStore.setState({ loading: false });
			}
		});
	pending = { source, promise };
	return promise;
}

const doiKey = (value: string | null | undefined) =>
	(value ?? "")
		.trim()
		.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
		.replace(/^doi:\s*/i, "")
		.toLowerCase();
const arxivKey = (value: string | null | undefined) =>
	(value ?? "")
		.trim()
		.replace(/^arxiv:\s*/i, "")
		.replace(/v\d+$/i, "")
		.toLowerCase();

export function poolLibraryIndex(
	library: PaperMetadata[],
): Map<string, PaperMetadata> {
	const index = new Map<string, PaperMetadata>();
	for (const paper of library) {
		index.set(`id:${paper.id}`, paper);
		if (paper.doi) index.set(`doi:${doiKey(paper.doi)}`, paper);
		if (paper.arxiv_id) index.set(`arxiv:${arxivKey(paper.arxiv_id)}`, paper);
	}
	return index;
}

export function poolPaperInLibrary(
	paper: PoolPaper,
	index: ReadonlyMap<string, PaperMetadata>,
): PaperMetadata | undefined {
	return (
		index.get(`id:pool-${paper.key.slice(0, 24)}`) ||
		(paper.doi ? index.get(`doi:${doiKey(paper.doi)}`) : undefined) ||
		(paper.arxivId ? index.get(`arxiv:${arxivKey(paper.arxivId)}`) : undefined)
	);
}

export function poolPaperSearchText(paper: PoolPaper): string {
	return [
		paper.title,
		paper.abstract,
		paper.doi,
		paper.arxivId,
		...paper.tags,
		...paper.authors.flatMap((author) => [
			author.name,
			...(author.affiliations ?? []),
		]),
		...paper.recommendations.flatMap((reason) => [
			reason.reason,
			reason.source,
		]),
	]
		.join(" ")
		.toLocaleLowerCase();
}
