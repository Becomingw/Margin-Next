import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-layout";
import { StatusDot } from "@/components/settings/status-dot";
import { Input } from "@/components/ui/input";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { TypedEventBinding } from "@/lib/core/tauri-events";

type ServerStatus = { listening: boolean; lastError: string | null };

/**
 * Status, enable switch and port for a loopback server the Host runs on the
 * user's behalf (Zotero Connector, MCP). Persists the setting through
 * `onEnabled` / `onPort` and mirrors live status from the Host event.
 */
export function useLocalServer<S extends ServerStatus>({
	getStatus,
	setEnabled,
	setPort,
	statusEvent,
	onEnabled,
	onPort,
	invalidPortMessage,
}: {
	getStatus: () => Promise<S>;
	setEnabled: (enabled: boolean) => Promise<S>;
	setPort: (port: number) => Promise<S>;
	statusEvent: TypedEventBinding<S>;
	onEnabled: (enabled: boolean) => void;
	onPort: (port: number) => void;
	invalidPortMessage: string;
}) {
	const [status, setStatus] = useState<S | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			setStatus(await getStatus());
		} catch {
			// ignore probe failures in settings
		}
	}, [getStatus]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useTauriEvent(statusEvent, setStatus);

	const toggle = async (enabled: boolean) => {
		onEnabled(enabled);
		if (!isTauri()) return;
		setBusy(true);
		try {
			const next = await setEnabled(enabled);
			setStatus(next);
			if (enabled && next.lastError) notifyError(next.lastError);
		} catch (e) {
			notifyError(errorText(e));
			onEnabled(false);
		} finally {
			setBusy(false);
		}
	};

	const commitPort = async (value: string) => {
		const port = Number.parseInt(value, 10);
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			notifyError(invalidPortMessage);
			return;
		}
		onPort(port);
		if (!isTauri()) return;
		try {
			setStatus(await setPort(port));
		} catch (e) {
			notifyError(errorText(e));
		}
	};

	return { status, busy, toggle, commitPort };
}

/** Port input with a "listening" dot; extra controls (copy URL…) go in `children`. */
export function ServerPortRow({
	id,
	label,
	port,
	listening,
	disabled,
	onCommit,
	children,
}: {
	id: string;
	label: string;
	port: number;
	listening: boolean;
	disabled: boolean;
	onCommit: (value: string) => void;
	children?: ReactNode;
}) {
	const { t } = useTranslation("common");
	return (
		<SettingsRow
			label={
				<>
					{label}
					{listening ? (
						<span className="ml-1.5">
							<StatusDot tone="ok" label={t("listening")} />
						</span>
					) : null}
				</>
			}
			htmlFor={id}
		>
			<Input
				id={id}
				type="number"
				min={1}
				max={65535}
				className="h-8 w-28"
				defaultValue={port}
				onBlur={(e) => onCommit(e.currentTarget.value)}
				disabled={disabled}
			/>
			{children}
		</SettingsRow>
	);
}
