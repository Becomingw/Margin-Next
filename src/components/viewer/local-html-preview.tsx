/**
 * Preview of an HTML file inside the Vault — typically a report or chart an
 * agent wrote. The page runs in a sandboxed frame served by `edda-preview://`
 * (relative assets resolve beside it; no access to the app or its IPC), with
 * a source view, reload, and reveal-in-file-manager.
 */
import { Code2, Eye, FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useIframeDragShield } from "@/components/viewer/html-viewer";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { readVaultFile } from "@/lib/vault/fs";
import { revealInFileManager, revealInOsLabelKey } from "@/lib/vault/reveal";
import { localPreviewUrl } from "@/lib/workspace/viewer/local-html";

type LocalHtmlPreviewProps = {
	/** Absolute path of the `.html` file. */
	path: string;
	vaultPath: string | null;
	title: string;
	/** Bumped when the file changes on disk; reloads the frame. */
	reloadKey?: number;
	className?: string;
};

export function LocalHtmlPreview({
	path,
	vaultPath,
	title,
	reloadKey = 0,
	className,
}: LocalHtmlPreviewProps) {
	const { t } = useTranslation(["viewer", "sidebar"]);
	const dragShield = useIframeDragShield();
	/** `undefined` while resolving; `null` when this file cannot be previewed. */
	const [src, setSrc] = useState<string | null | undefined>(undefined);
	const [showSource, setShowSource] = useState(false);
	const [source, setSource] = useState<string | null>(null);
	const [reloads, setReloads] = useState(0);

	useEffect(() => {
		let cancelled = false;
		setSrc(undefined);
		if (!vaultPath) {
			setSrc(null);
			return;
		}
		localPreviewUrl(vaultPath, path)
			.then((url) => !cancelled && setSrc(url))
			.catch(() => !cancelled && setSrc(null));
		return () => {
			cancelled = true;
		};
	}, [vaultPath, path]);

	// Without a frame the source is the only view.
	const sourceVisible = showSource || src === null;
	useEffect(() => {
		if (!sourceVisible) return;
		let cancelled = false;
		void reloadKey;
		readVaultFile(path)
			.then((text) => !cancelled && setSource(text))
			.catch(() => !cancelled && setSource(""));
		return () => {
			cancelled = true;
		};
	}, [sourceVisible, path, reloadKey]);

	const revealLabel = t(`sidebar:${revealInOsLabelKey()}`);
	return (
		<div
			className={cn("relative h-full min-h-0 w-full bg-background", className)}
		>
			{sourceVisible ? (
				<pre className="edda-scroll-both h-full w-full whitespace-pre p-4 font-mono text-xs leading-relaxed text-foreground">
					{source}
				</pre>
			) : src ? (
				<iframe
					key={`${reloadKey}:${reloads}`}
					src={src}
					title={title}
					// No allow-same-origin: the page gets an opaque origin, never the app's.
					sandbox="allow-scripts allow-forms allow-modals"
					className={cn(
						"h-full w-full border-0 bg-white",
						dragShield && "pointer-events-none",
					)}
				/>
			) : null}
			<div className="absolute top-2 right-3 z-10 flex items-center gap-0.5 rounded-lg border bg-background/90 p-0.5 shadow-floating backdrop-blur-sm">
				{src ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t(
							showSource ? "localHtml.preview" : "localHtml.source",
						)}
						title={t(showSource ? "localHtml.preview" : "localHtml.source")}
						aria-pressed={showSource}
						onClick={() => setShowSource((v) => !v)}
					>
						{showSource ? (
							<Eye className="size-3.5" />
						) : (
							<Code2 className="size-3.5" />
						)}
					</Button>
				) : null}
				{src && !showSource ? (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("localHtml.reload")}
						title={t("localHtml.reload")}
						onClick={() => setReloads((n) => n + 1)}
					>
						<RefreshCw className="size-3.5" />
					</Button>
				) : null}
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={revealLabel}
					title={revealLabel}
					onClick={() =>
						void revealInFileManager(path).catch(() =>
							notifyError(t("sidebar:fileTree.revealFailed")),
						)
					}
				>
					<FolderOpen className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}
