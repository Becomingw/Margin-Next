/**
 * Plaza source icon map — the components-layer half of the plaza registry.
 * `lib/plaza/sources.ts` only carries icon names ({@link PlazaSourceIcon});
 * this module resolves them to renderable components so lib stays free of
 * React/component imports.
 */

import type { ComponentType, SVGProps } from "react";
import { CoolPapersIcon } from "@/components/icons/cool-papers-icon";
import { ModelScopeIcon } from "@/components/icons/modelscope-icon";
import { objectIcon } from "@/components/icons/object-icon";
import type { PlazaSourceIcon } from "@/lib/plaza";

export const PLAZA_SOURCE_ICONS: Record<
	PlazaSourceIcon,
	ComponentType<SVGProps<SVGSVGElement>>
> = {
	coolPapers: CoolPapersIcon,
	modelScope: ModelScopeIcon,
	sparkles: objectIcon("skills"),
	paperPool: objectIcon("paperPool"),
	globe: objectIcon("globe"),
};
