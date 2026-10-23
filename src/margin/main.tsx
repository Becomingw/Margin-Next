import { ThemeProvider } from "next-themes";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { EditorDndProvider } from "@/components/editor/plugins/dnd-kit";
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PdfEngineHost } from "@/components/viewer/pdf/engine-provider";
import i18n, { applyLocale } from "@/i18n";
import { initAutoHideScrollbars } from "@/lib/core/scrollbars";
import { installMarginReviewApi } from "./api";
import { MarginApp } from "./margin-app";
import "@/index.css";
import "katex/dist/katex.min.css";

applyLocale("system");
installMarginReviewApi();
initAutoHideScrollbars();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<I18nextProvider i18n={i18n}>
		<ThemeProvider
			attribute="class"
			storageKey="margin-next.theme"
			defaultTheme="system"
			enableSystem
		>
			<TooltipProvider delayDuration={300}>
				<ErrorBoundary>
					<PdfEngineHost>
						<EditorDndProvider>
							<MarginApp />
						</EditorDndProvider>
					</PdfEngineHost>
				</ErrorBoundary>
				<Toaster />
			</TooltipProvider>
		</ThemeProvider>
	</I18nextProvider>,
);
