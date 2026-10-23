/**
 * Add a website to 浏览 (Browse), or rename one. Opened from the tree's
 * "Add website" row and the site context menu; mounted once by the file tree.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	addBrowseSite,
	normalizeSiteUrl,
	renameBrowseSite,
	watchBrowseAdapters,
} from "@/lib/browse/native-view";
import type { BrowseSite } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { browseSitePath } from "@/lib/plaza/sources";
import { openPath } from "@/lib/workspace/actions";

/** `null` closed; `"add"` a new site; a site to rename it. */
type DialogState = null | "add" | BrowseSite;

let state: DialogState = null;
const listeners = new Set<() => void>();
const setState = (next: DialogState) => {
	state = next;
	for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

export function openAddBrowseSite(): void {
	setState("add");
}

export function openRenameBrowseSite(site: BrowseSite): void {
	setState(site);
}

export function BrowseSiteDialog() {
	const { t } = useTranslation("sidebar");
	const current = useSyncExternalStore(subscribe, () => state);
	const renaming = current !== null && current !== "add" ? current : null;
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");

	// Mounted once with the tree: agent changes to site adapters surface here.
	useEffect(() => watchBrowseAdapters(), []);

	useEffect(() => {
		setUrl(renaming?.url ?? "");
		setName(renaming?.name ?? "");
	}, [renaming]);

	const submit = () => {
		if (renaming) {
			renameBrowseSite(renaming.id, name);
			setState(null);
			return;
		}
		const target = normalizeSiteUrl(url);
		if (!target) {
			notifyError(t("plaza.browse.invalidUrl"));
			return;
		}
		const site = addBrowseSite(target, name);
		setState(null);
		openPath(browseSitePath(site.id));
	};

	return (
		<Dialog
			open={current !== null}
			onOpenChange={(open) => {
				if (!open) setState(null);
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>
						{renaming ? t("plaza.browse.rename") : t("plaza.browse.addSite")}
					</DialogTitle>
				</DialogHeader>
				<form
					className="flex flex-col gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						submit();
					}}
				>
					<label
						htmlFor="browse-site-url"
						className="flex flex-col gap-1.5 text-xs text-muted-foreground"
					>
						{t("plaza.browse.url")}
						<Input
							id="browse-site-url"
							value={url}
							autoFocus={!renaming}
							disabled={Boolean(renaming)}
							spellCheck={false}
							placeholder={t("plaza.browse.urlPlaceholder")}
							onChange={(event) => setUrl(event.target.value)}
						/>
					</label>
					<label
						htmlFor="browse-site-name"
						className="flex flex-col gap-1.5 text-xs text-muted-foreground"
					>
						{t("plaza.browse.name")}
						<Input
							id="browse-site-name"
							value={name}
							autoFocus={Boolean(renaming)}
							placeholder={t("plaza.browse.namePlaceholder")}
							onChange={(event) => setName(event.target.value)}
						/>
					</label>
					<DialogFooter>
						<Button
							type="submit"
							disabled={renaming ? !name.trim() : !url.trim()}
						>
							{renaming ? t("plaza.browse.save") : t("plaza.browse.add")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
