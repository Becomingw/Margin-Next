import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/core/utils";

/** `off` = not configured; `idle` = configured but not checked / offline. */
export type StatusDotTone = "ok" | "idle" | "off" | "warn" | "err";

/** Probe lifecycle shared by provider keys (translate, layout, EasyScholar). */
export type ProbeStatus = "idle" | "probing" | "ok" | "fail";

const TONE_CLASS: Record<StatusDotTone, string> = {
	ok: "bg-emerald-500",
	idle: "bg-muted-foreground/45",
	off: "bg-muted-foreground/30",
	warn: "bg-amber-500",
	err: "bg-destructive",
};

export function probeTone(
	status: ProbeStatus,
	configured = true,
): StatusDotTone {
	switch (status) {
		case "ok":
			return "ok";
		case "fail":
			return "err";
		case "probing":
			return "warn";
		default:
			return configured ? "idle" : "off";
	}
}

/** The bare coloured dot; size / spacing come from `className`. */
export function Dot({
	tone,
	pulse = false,
	className,
}: {
	tone: StatusDotTone;
	pulse?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				TONE_CLASS[tone],
				pulse && "animate-pulse",
				className,
			)}
		/>
	);
}

/** Dot followed by its visible label. */
export function StatusDot({
	tone,
	label,
}: {
	tone: StatusDotTone;
	label: string;
}) {
	return (
		<span className="inline-flex items-center gap-2 text-muted-foreground text-xs leading-none">
			<span role="img" aria-label={label} className="inline-flex">
				<Dot tone={tone} className="ring-2 ring-background" />
			</span>
			<span className="font-medium text-foreground/80">{label}</span>
		</span>
	);
}

/** Small dot whose label lives in a tooltip (provider cards and selects). */
export function TooltipDot({
	tone,
	label,
	pulse,
}: {
	tone: StatusDotTone;
	label: string;
	pulse?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span role="status" aria-label={label} className="inline-flex">
					<Dot tone={tone} pulse={pulse} className="size-1.5" />
				</span>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
