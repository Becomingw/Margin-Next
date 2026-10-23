export {
	type BackgroundTask,
	BackgroundTaskCancelledError,
	type BackgroundTaskKind,
	backgroundTasksStore,
	cancelBackgroundTask,
	clearFinishedBackgroundTasks,
	completeBackgroundTask,
	failBackgroundTask,
	formatBytes,
	getActiveBackgroundTasks,
	isBackgroundTaskCancelledError,
	isFinishedBackgroundTask,
	setBackgroundTasksExpanded,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/lib/core/background-tasks";
export {
	commands,
	type TranslateTextArgs,
	type TranslateTextResult,
} from "@/lib/core/bindings";
export {
	copyTextToClipboard,
	readTextFromClipboard,
} from "@/lib/core/clipboard";
export { type Debounced, debounce } from "@/lib/core/debounce";
export { errorText } from "@/lib/core/error";
export {
	dataTransferLooksLikeImages,
	dataTransferLooksLikeOsFiles,
	dataTransferLooksLikePdfs,
	dataTransferLooksLikeVaultMove,
	dataTransferTypes,
	fileMatchesAccept,
	filesFromDataTransfer,
	hasImageExtension,
	hasPdfExtension,
	isPdfMimeOrUti,
} from "@/lib/core/file-accept";
export {
	IME_COMPOSITION_END_GRACE_MS,
	isImeKeyboardEvent,
} from "@/lib/core/ime";
export {
	type ApiError,
	type CallApiOptions,
	callApi,
	callApiResult,
	callResult,
	type TypedResult,
} from "@/lib/core/ipc";
export { createKeyedCache } from "@/lib/core/keyed-cache";
export { initLogger, logger } from "@/lib/core/logger";
export { clamp, clamp01 } from "@/lib/core/math";
export {
	MOTION_MS,
	prefersReducedMotion,
	scrollBehavior,
} from "@/lib/core/motion";
export {
	errorMessage,
	notifyAction,
	notifyError,
	notifySuccess,
	notifyUndo,
	notifyWarning,
} from "@/lib/core/notify";
export { openExternalUrl } from "@/lib/core/open-external";
export {
	closeTopOverlay,
	getOverlayStackSnapshot,
	isAnyOverlayOpen,
	pushOverlay,
	subscribeOverlayStack,
} from "@/lib/core/overlay-stack";
export {
	basenameOf,
	dirnameOf,
	joinPath,
	normalizePath,
	normalizeRelPath,
	toVaultRelative,
} from "@/lib/core/path";
export { initAutoHideScrollbars } from "@/lib/core/scrollbars";
export {
	readJsonStorage,
	removeStorageKey,
	type StorageLike,
	writeJsonStorage,
} from "@/lib/core/storage";
export {
	awaitTaskSettled,
	cancelTask,
	enqueueTask,
	enqueueTaskSettled,
	isTerminalJobState,
	type JobKind,
	type JobSnapshot,
	type JobState,
	registerTaskExecutor,
	reportTaskPhase,
	runLocalActivity,
	startTaskRuntime,
	type TaskExecutor,
	type TaskExecutorContext,
	type TaskReportArgs,
	type TaskSpec,
	throwIfTaskCancelled,
} from "@/lib/core/tasks";
export {
	getPlatformOS,
	isMacOS,
	isMobileApp,
	isTauri,
	isWindows,
} from "@/lib/core/tauri";
export {
	broadcastSafe,
	listenEventSafe,
	type TauriEventHandler,
	type TypedEventBinding,
	toSafeDisposer,
} from "@/lib/core/tauri-events";
export { cn, mapLimit } from "@/lib/core/utils";
export {
	beginVaultFileDrag,
	endVaultFileDrag,
	isVaultFileDragActive,
	VAULT_FILE_DRAG_TYPE,
} from "@/lib/core/vault-file-drag";
export {
	type FloatingSide,
	placeViewportFloating,
	type ViewportFloatingPlacement,
	type ViewportPoint,
} from "@/lib/core/viewport-placement";
