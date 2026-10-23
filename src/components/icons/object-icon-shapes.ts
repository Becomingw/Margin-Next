/**
 * Shapes of Edda's colored object icons (16×16 grid, duotone).
 *
 * Objects — folders, papers, file types, sidebar places, settings sections —
 * get a soft tinted body and a strong outline of one hue; action buttons stay
 * monochrome lucide icons. Colors come from the `--icon-<hue>` /
 * `--icon-<hue>-soft` tokens (docs/design.md), so both themes adapt.
 */

export type IconHue =
	| "copper"
	| "amber"
	| "rose"
	| "green"
	| "teal"
	| "blue"
	| "violet"
	| "slate";

/**
 * How a path is painted:
 * - `body`: soft fill, strong outline
 * - `line`: strong stroke only
 * - `hint`: faint strong stroke (secondary structure)
 * - `solid`: strong fill, no stroke
 * - `knock`: soft stroke (marks drawn on a solid shape)
 */
export type IconRole = "body" | "line" | "hint" | "solid" | "knock";

export type IconPath = {
	d: string;
	role: IconRole;
	/** Overrides the icon's hue for this path (palette dots). */
	hue?: IconHue;
	/** Stroke width; default 1.2. */
	w?: number;
};

export type IconShape = { hue: IconHue; paths: IconPath[] };

const circle = (cx: number, cy: number, r: number) =>
	`M${cx + r} ${cy}a${r} ${r} 0 1 1 ${-2 * r} 0a${r} ${r} 0 1 1 ${2 * r} 0z`;

/** Page with a folded corner; file-type marks go on top. */
const PAGE: IconPath[] = [
	{
		d: "M4 1.75h5.1c.33 0 .65.13.88.37l2.4 2.4c.24.23.37.55.37.88v8.35c0 .69-.56 1.25-1.25 1.25H4c-.69 0-1.25-.56-1.25-1.25V3c0-.69.56-1.25 1.25-1.25z",
		role: "body",
	},
	{ d: "M9.25 1.9v2.35c0 .41.34.75.75.75h2.35", role: "line" },
];

const TEXT_LINES: IconPath[] = [
	{ d: "M5.25 8h5.5", role: "line" },
	{ d: "M5.25 10.25h5.5", role: "line" },
	{ d: "M5.25 12.5h3.25", role: "line" },
];

const CHEVRONS: IconPath[] = [
	{ d: "M6.4 8.6 5 10l1.4 1.4", role: "line" },
	{ d: "M9.6 8.6 11 10l-1.4 1.4", role: "line" },
];

const FOLDER_BODY =
	"M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.4c.46 0 .9.18 1.24.51l.7.7c.33.33.77.51 1.24.51h3.42c.97 0 1.75.78 1.75 1.75v5.53c0 .97-.78 1.75-1.75 1.75H3.5c-.97 0-1.75-.78-1.75-1.75z";

export const OBJECT_ICON_SHAPES = {
	folder: {
		hue: "amber",
		paths: [
			{ d: FOLDER_BODY, role: "body" },
			{ d: "M1.9 6.75h12.2", role: "hint" },
		],
	},
	folderOpen: {
		hue: "amber",
		paths: [
			{ d: FOLDER_BODY, role: "body" },
			{
				d: "M3.6 7.25h10.65l-1.5 6.5H2.1z",
				role: "body",
			},
		],
	},
	paper: {
		hue: "copper",
		paths: [
			{
				d: "M3.75 1.75h8.5c.69 0 1.25.56 1.25 1.25v10c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V3c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M9.5 1.75h2.5v4.6l-1.25-.85-1.25.85z", role: "solid" },
			{ d: "M4.75 4.75h3", role: "line", w: 1.6 },
			{ d: "M4.75 8h6.5", role: "line" },
			{ d: "M4.75 10.25h6.5", role: "line" },
			{ d: "M4.75 12.25h4.25", role: "line" },
		],
	},
	papers: {
		hue: "copper",
		paths: [
			{ d: "M5.25 1.5h7.25c.69 0 1.25.56 1.25 1.25v9", role: "line" },
			{
				d: "M3.5 3.5h7c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25h-7c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M4.75 6.75h4.5", role: "line", w: 1.5 },
			{ d: "M4.75 9.25h4.5", role: "line" },
			{ d: "M4.75 11.5h3", role: "line" },
		],
	},
	notes: {
		hue: "blue",
		paths: [
			{
				d: "M4.25 1.75h7.5c.69 0 1.25.56 1.25 1.25v10c0 .69-.56 1.25-1.25 1.25h-7.5C3.56 14.25 3 13.69 3 13V3c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M5.9 1.9v12.2", role: "hint" },
			{ d: "M2 4.5h2", role: "line" },
			{ d: "M2 8h2", role: "line" },
			{ d: "M2 11.5h2", role: "line" },
			{ d: "M7.75 5.25h3", role: "line" },
			{ d: "M7.75 7.75h3", role: "line" },
		],
	},
	review: {
		hue: "teal",
		paths: [
			{
				d: "M3.75 2.5h8.5c.69 0 1.25.56 1.25 1.25v9.25c0 .69-.56 1.25-1.25 1.25h-8.5c-.69 0-1.25-.56-1.25-1.25V3.75c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{
				d: "M6 1.5h4c.41 0 .75.34.75.75v1c0 .41-.34.75-.75.75H6c-.41 0-.75-.34-.75-.75v-1c0-.41.34-.75.75-.75z",
				role: "solid",
			},
			{ d: "M5 6.75h6", role: "line" },
			{ d: "M5 9h3.5", role: "line" },
			{ d: "M6 11.6 7.35 13 10.5 9.85", role: "line", w: 1.5 },
		],
	},
	reviews: {
		hue: "teal",
		paths: [
			{ d: "M5.25 1.5h7.25c.69 0 1.25.56 1.25 1.25v9", role: "line" },
			{
				d: "M3.5 3.5h7c.69 0 1.25.56 1.25 1.25v8.5c0 .69-.56 1.25-1.25 1.25h-7c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M4.75 6.75h4.5", role: "line" },
			{ d: "M4.75 9h2.75", role: "line" },
			{ d: "M5.25 11.4 6.5 12.65 9.25 9.9", role: "line", w: 1.5 },
		],
	},
	library: {
		hue: "copper",
		paths: [
			{
				d: "M2.25 3.25c0-.41.34-.75.75-.75h1.75c.41 0 .75.34.75.75v10c0 .41-.34.75-.75.75H3c-.41 0-.75-.34-.75-.75z",
				role: "body",
			},
			{
				d: "M6.25 2.25c0-.41.34-.75.75-.75h1.75c.41 0 .75.34.75.75v11c0 .41-.34.75-.75.75H7c-.41 0-.75-.34-.75-.75z",
				role: "solid",
			},
			{ d: "M6.9 4.25h1.95", role: "knock" },
			{ d: "M6.9 11.75h1.95", role: "knock" },
			{
				d: "M10.4 3.6c.1-.4.5-.64.9-.54l1.7.43c.4.1.64.5.54.9l-2.45 9.7c-.1.4-.5.64-.9.54l-1.7-.43c-.4-.1-.64-.5-.54-.9z",
				role: "body",
			},
		],
	},
	paperPool: {
		hue: "amber",
		paths: [
			{
				d: "M1.75 9.25l1.6-5.1c.2-.62.77-1.05 1.43-1.05h6.44c.66 0 1.23.43 1.43 1.05l1.6 5.1v3.25c0 .97-.78 1.75-1.75 1.75H3.5c-.97 0-1.75-.78-1.75-1.75z",
				role: "body",
			},
			{ d: "M1.9 9.25h3l.9 1.5h4.4l.9-1.5h3", role: "line" },
			{ d: "M6 5.5h4", role: "line" },
			{ d: "M5.5 7.25h5", role: "line" },
		],
	},
	trash: {
		hue: "rose",
		paths: [
			{
				d: "M3.75 4.25h8.5l-.7 8.86c-.06.78-.71 1.39-1.5 1.39H5.95c-.79 0-1.44-.61-1.5-1.39z",
				role: "body",
			},
			{ d: "M2.25 4.25h11.5", role: "line" },
			{
				d: "M6.25 4.1v-.6c0-.69.56-1.25 1.25-1.25h1c.69 0 1.25.56 1.25 1.25v.6",
				role: "line",
			},
			{ d: "M6.6 7v4.5", role: "line" },
			{ d: "M9.4 7v4.5", role: "line" },
		],
	},
	skills: {
		hue: "violet",
		paths: [
			{
				d: "M7 2.25l1.06 3.19c.15.45.5.8.95.95l3.19 1.06-3.19 1.06c-.45.15-.8.5-.95.95L7 12.65 5.94 9.46c-.15-.45-.5-.8-.95-.95L1.8 7.45l3.19-1.06c.45-.15.8-.5.95-.95z",
				role: "body",
			},
			{
				d: "M12.5 9.75l.45 1.2 1.2.45-1.2.45-.45 1.2-.45-1.2-1.2-.45 1.2-.45z",
				role: "solid",
			},
			{
				d: "M12.25 1.5l.32.83.83.32-.83.32-.32.83-.32-.83-.83-.32.83-.32z",
				role: "solid",
			},
		],
	},
	globe: {
		hue: "green",
		paths: [
			{ d: circle(8, 8, 6.25), role: "body" },
			{ d: "M2.75 5h10.5", role: "hint" },
			{ d: "M2.75 11h10.5", role: "hint" },
			{ d: "M1.9 8h12.2", role: "line" },
			{
				d: "M8 1.75c-1.7 1.6-2.6 3.7-2.6 6.25s.9 4.65 2.6 6.25c1.7-1.6 2.6-3.7 2.6-6.25S9.7 3.35 8 1.75z",
				role: "line",
			},
		],
	},
	fileText: { hue: "slate", paths: [...PAGE, ...TEXT_LINES] },
	fileMarkdown: { hue: "blue", paths: [...PAGE, ...TEXT_LINES] },
	filePdf: {
		hue: "rose",
		paths: [
			...PAGE,
			{ d: "M5.25 6.75h4", role: "line" },
			{
				d: "M2.25 9.5c0-.41.34-.75.75-.75h7c.41 0 .75.34.75.75v2.75c0 .41-.34.75-.75.75H3c-.41 0-.75-.34-.75-.75z",
				role: "solid",
			},
		],
	},
	fileImage: {
		hue: "green",
		paths: [
			...PAGE,
			{ d: circle(9.6, 7.6, 0.95), role: "solid" },
			{ d: "M4.25 12.75l2.3-3 1.6 1.9 1.2-1.3 1.9 2.4z", role: "solid" },
		],
	},
	fileCode: { hue: "teal", paths: [...PAGE, ...CHEVRONS] },
	fileHtml: { hue: "copper", paths: [...PAGE, ...CHEVRONS] },
	fileJson: {
		hue: "teal",
		paths: [
			...PAGE,
			{
				d: "M6.6 8c-.6 0-.9.3-.9.9v.45c0 .4-.2.65-.65.65.45 0 .65.25.65.65v.45c0 .6.3.9.9.9",
				role: "line",
			},
			{
				d: "M9.4 8c.6 0 .9.3.9.9v.45c0 .4.2.65.65.65-.45 0-.65.25-.65.65v.45c0 .6-.3.9-.9.9",
				role: "line",
			},
		],
	},

	// Settings sections
	settingsGeneral: {
		hue: "copper",
		paths: [
			{ d: "M2.25 4.25h11.5", role: "line" },
			{ d: "M2.25 8h11.5", role: "line" },
			{ d: "M2.25 11.75h11.5", role: "line" },
			{ d: circle(5, 4.25, 1.6), role: "body" },
			{ d: circle(10.75, 8, 1.6), role: "body" },
			{ d: circle(6.75, 11.75, 1.6), role: "body" },
		],
	},
	settingsAppearance: {
		hue: "slate",
		paths: [
			{
				d: "M8 1.75c-3.45 0-6.25 2.65-6.25 5.9 0 3.3 2.8 6.6 6.4 6.6.9 0 1.35-.55 1.35-1.2 0-.55-.35-.85-.35-1.4 0-.65.5-1.15 1.2-1.15h1.45c1.8 0 2.45-1.4 2.45-2.85 0-3.2-2.8-5.9-6.25-5.9z",
				role: "body",
			},
			{ d: circle(4.9, 7.1, 1), role: "solid", hue: "rose" },
			{ d: circle(7.3, 4.5, 1), role: "solid", hue: "amber" },
			{ d: circle(10.4, 5.4, 1), role: "solid", hue: "green" },
			{ d: circle(5.6, 10.35, 1), role: "solid", hue: "blue" },
		],
	},
	settingsAgent: {
		hue: "violet",
		paths: [
			{
				d: "M3.5 5.25h9c.69 0 1.25.56 1.25 1.25v5.25c0 .69-.56 1.25-1.25 1.25h-9c-.69 0-1.25-.56-1.25-1.25V6.5c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M8 5.1V3.4", role: "line" },
			{ d: circle(8, 2.55, 0.9), role: "solid" },
			{ d: circle(6, 8.6, 0.9), role: "solid" },
			{ d: circle(10, 8.6, 0.9), role: "solid" },
			{ d: "M6.9 10.75h2.2", role: "line" },
			{ d: "M1 8.25v1.5", role: "line" },
			{ d: "M15 8.25v1.5", role: "line" },
		],
	},
	settingsTranslate: {
		hue: "blue",
		paths: [
			{
				d: "M3.75 1.75h4.5c.83 0 1.5.67 1.5 1.5v3.5c0 .83-.67 1.5-1.5 1.5H5.6L3.75 9.6V8.2c-.7-.12-1.25-.73-1.25-1.45V3.25c0-.83.67-1.5 1.5-1.5z",
				role: "body",
			},
			{ d: "M4.25 3.9h3.5", role: "line" },
			{ d: "M6 3.9c0 1.3-.55 2.25-1.6 2.75", role: "line" },
			{
				d: "M8 7.75h4.5c.83 0 1.5.67 1.5 1.5v3c0 .83-.67 1.5-1.5 1.5h-.25v1.4l-1.9-1.4H8c-.83 0-1.5-.67-1.5-1.5v-3c0-.83.67-1.5 1.5-1.5z",
				role: "body",
			},
			{ d: "M8.75 12.4l1.35-3.2 1.35 3.2", role: "line" },
			{ d: "M9.25 11.3h1.7", role: "line" },
		],
	},
	settingsLayout: {
		hue: "amber",
		paths: [
			{
				d: "M2.75 2h10.5c.41 0 .75.34.75.75v10.5c0 .41-.34.75-.75.75H2.75c-.41 0-.75-.34-.75-.75V2.75c0-.41.34-.75.75-.75z",
				role: "body",
			},
			{ d: "M3.9 3.9h8.2v2.35H3.9z", role: "solid" },
			{ d: "M3.9 7.75h3.6v4.35H3.9z", role: "solid" },
			{ d: "M9.25 8.25h2.75", role: "line" },
			{ d: "M9.25 10.25h2.75", role: "line" },
			{ d: "M9.25 12.1h1.75", role: "line" },
		],
	},
	settingsNetwork: {
		hue: "green",
		paths: [
			{ d: "M7 5.4 4.8 10.2", role: "line" },
			{ d: "M9 5.4l2.2 4.8", role: "line" },
			{ d: "M5.9 12.25h4.2", role: "line" },
			{ d: circle(8, 3.75, 2), role: "body" },
			{ d: circle(3.75, 12.25, 2), role: "body" },
			{ d: circle(12.25, 12.25, 2), role: "body" },
		],
	},
	settingsRemote: {
		hue: "teal",
		paths: [
			{
				d: "M2.25 2.5h8.5c.69 0 1.25.56 1.25 1.25v5c0 .69-.56 1.25-1.25 1.25h-8.5C1.56 10 1 9.44 1 8.75v-5c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{ d: "M6.5 10v2.75", role: "line" },
			{ d: "M4.75 13h3.5", role: "line" },
			{
				d: "M11.5 6.5h2.25c.55 0 1 .45 1 1v5.75c0 .55-.45 1-1 1H11.5c-.55 0-1-.45-1-1V7.5c0-.55.45-1 1-1z",
				role: "body",
			},
			{ d: "M12.2 12.5h.85", role: "line" },
		],
	},
	settingsSync: {
		hue: "blue",
		paths: [
			{
				d: "M4.6 12.5a3.05 3.05 0 0 1-.4-6.07 3.9 3.9 0 0 1 7.5-.95 3.25 3.25 0 0 1 .05 7.02z",
				role: "body",
			},
			{ d: "M8 13.9V8.4", role: "line" },
			{ d: "M6.2 10.2 8 8.4l1.8 1.8", role: "line" },
		],
	},
	settingsDoctor: {
		hue: "rose",
		paths: [
			{ d: "M4 2.25v3.75a3 3 0 0 0 6 0V2.25", role: "line" },
			{ d: "M3.25 2.25h1.5", role: "line" },
			{ d: "M9.25 2.25h1.5", role: "line" },
			{ d: "M7 9v1.5a2.5 2.5 0 0 0 5 0v-.9", role: "line" },
			{ d: circle(12, 7.85, 1.75), role: "body" },
		],
	},
	settingsKeyboard: {
		hue: "slate",
		paths: [
			{
				d: "M2.25 3.75h11.5c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H2.25C1.56 12.25 1 11.69 1 11V5c0-.69.56-1.25 1.25-1.25z",
				role: "body",
			},
			{
				d: "M3.75 6.4h.01M6 6.4h.01M8.25 6.4h.01M10.5 6.4h.01M12.5 6.4h.01",
				role: "line",
				w: 1.7,
			},
			{
				d: "M4.75 8.4h.01M7 8.4h.01M9.25 8.4h.01M11.5 8.4h.01",
				role: "line",
				w: 1.7,
			},
			{ d: "M5.5 10.4h5", role: "line" },
		],
	},
	settingsAbout: {
		hue: "blue",
		paths: [
			{ d: circle(8, 8, 6.25), role: "body" },
			{ d: "M8 7.4v3.85", role: "line", w: 1.5 },
			{ d: circle(8, 5, 0.9), role: "solid" },
		],
	},
} satisfies Record<string, IconShape>;

export type ObjectIconKind = keyof typeof OBJECT_ICON_SHAPES;
