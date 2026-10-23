/**
 * Shared chip / mention-row icon (paper / folder / typed file).
 */
import { ObjectIcon } from "@/components/icons/object-icon";
import { contextPathIconKind } from "@/lib/agent/context-path-icon";

export function ContextPathIcon({
	path,
	directoryPaths,
	paperPaths,
}: {
	path: string;
	directoryPaths: ReadonlySet<string>;
	paperPaths: ReadonlySet<string>;
}) {
	return (
		<ObjectIcon
			kind={contextPathIconKind(path, { directoryPaths, paperPaths })}
			className="size-3.5 shrink-0"
		/>
	);
}
