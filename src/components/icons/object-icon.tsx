/**
 * Colored duotone icons for objects (folders, papers, file types, sidebar
 * places, settings sections). Actions keep monochrome lucide icons.
 * Shapes: `object-icon-shapes.ts`; colors: `--icon-*` tokens (docs/design.md).
 */
import type { ComponentType, CSSProperties, SVGProps } from "react";
import {
	type IconHue,
	type IconPath,
	OBJECT_ICON_SHAPES,
	type ObjectIconKind,
} from "@/components/icons/object-icon-shapes";

export type { ObjectIconKind };

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

const strong = (hue: IconHue) => `var(--icon-${hue})`;
const soft = (hue: IconHue) => `var(--icon-${hue}-soft)`;

function paint(path: IconPath, hue: IconHue): CSSProperties {
	const h = path.hue ?? hue;
	const width = path.w ?? 1.2;
	switch (path.role) {
		case "body":
			return { fill: soft(h), stroke: strong(h), strokeWidth: width };
		case "line":
			return { stroke: strong(h), strokeWidth: width };
		case "hint":
			return { stroke: strong(h), strokeWidth: width, strokeOpacity: 0.45 };
		case "solid":
			return { fill: strong(h) };
		case "knock":
			return { stroke: soft(h), strokeWidth: width };
	}
}

export function ObjectIcon({
	kind,
	className,
	...props
}: IconProps & { kind: ObjectIconKind }) {
	const shape = OBJECT_ICON_SHAPES[kind];
	return (
		<svg
			viewBox="0 0 16 16"
			fill="none"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			className={className}
			{...props}
		>
			{shape.paths.map((path, index) => (
				<path
					// biome-ignore lint/suspicious/noArrayIndexKey: static shape list
					key={index}
					d={path.d}
					style={paint(path, shape.hue)}
				/>
			))}
		</svg>
	);
}

const cache = new Map<ObjectIconKind, ComponentType<IconProps>>();

/** A component for one kind, for APIs that take an icon component. */
export function objectIcon(kind: ObjectIconKind): ComponentType<IconProps> {
	let component = cache.get(kind);
	if (!component) {
		component = (props: IconProps) => <ObjectIcon kind={kind} {...props} />;
		cache.set(kind, component);
	}
	return component;
}
