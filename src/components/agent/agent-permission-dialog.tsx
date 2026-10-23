import { FileText, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type PermissionRequest, respondPermission } from "@/lib/agent";
import { basenameOf } from "@/lib/core/path";

function formatPermissionKind(
	kind: string,
	t: (
		key:
			| "permission.kind.allowOnce"
			| "permission.kind.allowAlways"
			| "permission.kind.rejectOnce"
			| "permission.kind.rejectAlways",
	) => string,
): string {
	switch (kind) {
		case "allow_once":
			return t("permission.kind.allowOnce");
		case "allow_always":
			return t("permission.kind.allowAlways");
		case "reject_once":
			return t("permission.kind.rejectOnce");
		case "reject_always":
			return t("permission.kind.rejectAlways");
		default:
			return kind;
	}
}

export function AgentPermissionDialog({
	permissionRequest,
	onDismiss,
}: {
	permissionRequest: PermissionRequest | null;
	/** Clear local state after respond / close (caller owns the request). */
	onDismiss: () => void;
}) {
	const { t } = useTranslation("agent");

	return (
		<Dialog
			open={permissionRequest !== null}
			onOpenChange={(open) => {
				if (!open && permissionRequest) {
					void respondPermission(permissionRequest.requestId, null);
					onDismiss();
				}
			}}
		>
			<DialogContent className="max-w-md">
				{permissionRequest ? (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<ShieldCheck className="size-4 text-primary" aria-hidden />
								{t("permission.title")}
							</DialogTitle>
							<DialogDescription>{permissionRequest.title}</DialogDescription>
						</DialogHeader>
						{permissionRequest.paths.length ? (
							<div className="flex max-h-36 flex-col gap-0.5 overflow-y-auto rounded-lg border bg-muted/40 p-1.5">
								{permissionRequest.paths.map((p) => (
									<span
										key={p}
										className="flex min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs"
										title={p}
									>
										<FileText
											className="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden
										/>
										{/* File name first: an end-truncated path would hide it. */}
										<code className="shrink-0">{basenameOf(p)}</code>
										<code className="min-w-0 truncate text-muted-foreground">
											{p.slice(0, p.length - basenameOf(p).length)}
										</code>
									</span>
								))}
							</div>
						) : null}
						<DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
							{permissionRequest.options.map((opt, index) => (
								<Button
									key={opt.optionId}
									// One primary action; further allow options stay secondary.
									variant={
										index === 0 && opt.kind.startsWith("allow")
											? "default"
											: "outline"
									}
									onClick={() => {
										void respondPermission(
											permissionRequest.requestId,
											opt.optionId,
										);
										onDismiss();
									}}
								>
									{opt.name || formatPermissionKind(opt.kind, t)}
								</Button>
							))}
							<Button
								variant="ghost"
								onClick={() => {
									void respondPermission(permissionRequest.requestId, null);
									onDismiss();
								}}
							>
								{t("permission.deny")}
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
