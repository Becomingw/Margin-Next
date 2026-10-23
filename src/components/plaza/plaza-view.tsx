/**
 * 广场（Plaza）center panel: one embedded source per tab.
 *
 * The tree root node is a plain virtual folder (expand/collapse only) with no
 * page of its own; each child row opens its source's tab. Everything is
 * derived from the {@link PLAZA_SOURCES} registry, so a new source needs no
 * changes here. Websites (built-in and user-added) are native Browse views.
 */

import { BrowseView } from "@/components/plaza/browse-view";
import { PaperPoolView } from "@/components/plaza/paper-pool-view";
import { SkillManager } from "@/components/plaza/skill-manager";
import { browsePanelSite, plazaSourceForPath } from "@/lib/plaza";

export function PlazaView({
	path,
	className,
}: {
	path: string;
	className?: string;
}) {
	const source = plazaSourceForPath(path);

	if (source?.panel === "skills") {
		return <SkillManager className={className} />;
	}

	if (source?.panel === "paperPool") {
		return <PaperPoolView className={className} />;
	}

	if (source?.panel === "browse") {
		const site = browsePanelSite(source);
		return site ? (
			<BrowseView key={site.id} site={site} path={path} className={className} />
		) : null;
	}

	// The Plaza root has no page of its own — it is a tree folder only.
	return null;
}
