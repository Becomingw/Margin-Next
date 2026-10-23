import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/core/utils";

/**
 * Service provider config card (translate / layout). Collapsed to its header
 * row unless open, so only the provider in use shows its fields by default.
 */
export function ProviderCard({
	label,
	open,
	onToggle,
	header,
	actions,
	children,
}: {
	/** Provider name, used as the toggle's accessible label. */
	label: string;
	open: boolean;
	onToggle: () => void;
	/** Status dot, name and docs link. */
	header: ReactNode;
	/** Shown on the right while open (e.g. Confirm). */
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="rounded-lg border bg-card px-3 py-2.5">
			<div
				className={cn(
					"flex items-center justify-between gap-2",
					open && "mb-2",
				)}
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<button
						type="button"
						aria-label={label}
						aria-expanded={open}
						onClick={onToggle}
						className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<ChevronRight
							className={cn(
								"size-3.5 transition-transform",
								open && "rotate-90",
							)}
							aria-hidden
						/>
					</button>
					{header}
				</div>
				{open ? actions : null}
			</div>
			{open ? children : null}
		</div>
	);
}

/** One labelled field inside a ProviderCard (API key, base URL, model…). */
export function ProviderField({
	id,
	label,
	children,
}: {
	id: string;
	label: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center gap-2">
			<Label
				htmlFor={id}
				className="w-20 shrink-0 font-normal text-muted-foreground text-xs"
			>
				{label}
			</Label>
			{children}
		</div>
	);
}
