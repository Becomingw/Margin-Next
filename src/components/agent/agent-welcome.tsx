import {
	type AnimationPlaybackControls,
	animate as animateValue,
	type MotionValue,
	motion,
	useIsPresent,
	useMotionValue,
	useSpring,
	useTransform,
} from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MathText } from "@/components/ui/math-text";
import "./agent-welcome.css";

type Expression =
	| "idle"
	| "surprised"
	| "wink"
	| "curious"
	| "sleepy"
	| "thinking"
	| "shy"
	| "dizzy"
	| "ouch";

type Track = "x" | "y" | "rotate" | "scaleX" | "scaleY" | "turn";

/**
 * One activity: a face plus body keyframes (px / deg; `turn` slides the
 * face across the head in viewBox units). Every track shares `times` and
 * starts and ends at rest. `loop` holds until something else plays;
 * `priority` reactions are not interrupted by hover or approach.
 */
type Act = {
	face: Expression;
	duration: number;
	times: number[];
	loop?: boolean;
	priority?: boolean;
} & Partial<Record<Track, number[]>>;

const HOP: Act = {
	face: "idle",
	duration: 1.1,
	times: [0, 0.14, 0.36, 0.58, 0.76, 1],
	y: [0, 2, -16, 0, -7, 0],
	scaleX: [1, 1.08, 0.95, 1.07, 0.98, 1],
	scaleY: [1, 0.9, 1.07, 0.92, 1.03, 1],
};

const ACTS: Act[] = [
	HOP,
	{
		face: "surprised",
		duration: 0.8,
		times: [0, 0.15, 0.45, 0.75, 1],
		y: [0, 2, -12, 0, 0],
		scaleX: [1, 1.08, 0.94, 1.05, 1],
		scaleY: [1, 0.9, 1.1, 0.94, 1],
	},
	{
		face: "wink",
		duration: 1.8,
		times: [0, 0.2, 0.8, 1],
		x: [0, 5, 5, 0],
		rotate: [0, 10, 10, 0],
		turn: [0, 4, 4, 0],
	},
	{
		face: "curious",
		duration: 2.2,
		times: [0, 0.2, 0.8, 1],
		x: [0, -5, -5, 0],
		y: [0, -2, -2, 0],
		rotate: [0, -12, -12, 0],
		turn: [0, -8, -8, 0],
	},
	{
		face: "sleepy",
		duration: 3,
		times: [0, 0.25, 0.5, 0.75, 1],
		y: [0, 3, 1, 3, 0],
		rotate: [0, 6, 2, 6, 0],
		scaleX: [1, 1.03, 1.01, 1.03, 1],
		scaleY: [1, 0.96, 0.98, 0.96, 1],
	},
	{
		face: "thinking",
		duration: 2.4,
		times: [0, 0.2, 0.4, 0.6, 0.8, 1],
		y: [0, -2, 0, -2, 0, 0],
		rotate: [0, -6, -3, -6, -3, 0],
		turn: [0, 7, 7, 7, 7, 0],
	},
	// Look around: the face swings to one side, then the other.
	{
		face: "idle",
		duration: 2.6,
		times: [0, 0.18, 0.42, 0.58, 0.82, 1],
		rotate: [0, -4, -4, 4, 4, 0],
		turn: [0, -11, -11, 11, 11, 0],
	},
	// Spin: the face slides off one edge and comes back from the other.
	{
		face: "idle",
		duration: 1.2,
		times: [0, 0.38, 0.381, 0.8, 1],
		y: [0, -8, -8, 0, 0],
		scaleX: [1, 0.92, 0.92, 1.04, 1],
		turn: [0, 64, -64, 0, 0],
	},
	// Wiggle.
	{
		face: "idle",
		duration: 1.6,
		times: [0, 0.15, 0.32, 0.5, 0.68, 0.85, 1],
		y: [0, -3, 0, -3, 0, -2, 0],
		rotate: [0, -9, 9, -9, 9, -4, 0],
	},
];

// Pointer reactions.

/** Startled awake, or poked while dozing. */
const STARTLE: Act = { ...ACTS[1], priority: true };

/** Pointer resting on the head. */
const SHY: Act = {
	face: "shy",
	duration: 1.8,
	times: [0, 0.5, 1],
	loop: true,
	y: [0, 1.5, 0],
	rotate: [0, -4, 0],
	scaleX: [1, 1.02, 1],
	scaleY: [1, 0.97, 1],
};

/** Clicked on the head. */
const OUCH: Act = {
	face: "ouch",
	duration: 0.8,
	times: [0, 0.15, 0.4, 0.7, 1],
	priority: true,
	y: [0, 3, -5, 0, 0],
	scaleX: [1, 1.16, 0.94, 1.03, 1],
	scaleY: [1, 0.8, 1.07, 0.98, 1],
};

/** The pointer was shaken hard. */
const DIZZY: Act = {
	face: "dizzy",
	duration: 2.4,
	times: [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.85, 1],
	priority: true,
	x: [0, -3, 3, -3, 3, -2, 1, 0],
	rotate: [0, -11, 10, -9, 8, -5, 3, 0],
};

/** No pointer movement for a while. */
const DOZE: Act = {
	face: "sleepy",
	duration: 3.2,
	times: [0, 0.5, 1],
	loop: true,
	y: [0, 3, 0],
	rotate: [0, 5, 0],
	scaleY: [1, 0.96, 1],
};

/** The pointer left the window. */
const SEARCH: Act = {
	face: "curious",
	duration: 2.6,
	times: [0, 0.18, 0.42, 0.58, 0.82, 1],
	rotate: [0, -5, -5, 5, 5, 0],
	turn: [0, -12, -12, 12, 12, 0],
};

/** The pointer came close: lean toward it (`side` is -1 or 1). */
const notice = (side: number): Act => ({
	face: "curious",
	duration: 1.4,
	times: [0, 0.25, 0.75, 1],
	x: [0, 4 * side, 4 * side, 0],
	y: [0, -4, -2, 0],
	rotate: [0, 9 * side, 9 * side, 0],
	turn: [0, 5 * side, 5 * side, 0],
});

const SLEEP_AFTER_MS = 30_000;
/** Shaking: enough fast travel (px, decaying over ~0.4s) with several
 * back-and-forth reversals inside a second, so a single fling doesn't count. */
const SHAKE_ENERGY = 1200;
const SHAKE_REVERSALS = 4;

const BLUSH: Record<Expression, number> = {
	idle: 0.55,
	surprised: 0.4,
	wink: 0.75,
	curious: 0.55,
	sleepy: 0.45,
	thinking: 0.45,
	shy: 1,
	dizzy: 0.5,
	ouch: 0.75,
};

const INK = "#1a1b21";

const between = (min: number, max: number) => min + Math.random() * (max - min);
const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/** A decorative, local-only companion. Never consumes clicks, focus or prompts. */
export function AgentWelcome({ title }: { title: string }) {
	const { t } = useTranslation("agent");
	const root = useRef<HTMLDivElement>(null);
	const scene = useRef<HTMLDivElement>(null);
	const present = useIsPresent();
	const [reducedMotion, setReducedMotion] = useState(true);
	const [visible, setVisible] = useState(false);
	const animate = present && visible && reducedMotion === false;
	const [expression, setExpression] = useState<Expression>("idle");
	const id = `welcome-bot-${useId().replace(/:/g, "")}`;

	// Pointer follow: eyes, a slight face turn and head tilt.
	const eyeX = useSpring(0, { stiffness: 170, damping: 20 });
	const eyeY = useSpring(0, { stiffness: 170, damping: 20 });
	const lookTurn = useSpring(0, { stiffness: 120, damping: 20 });
	const tilt = useSpring(0, { stiffness: 110, damping: 22 });

	// Body activity, driven by ACTS.
	const body: Record<Track, MotionValue<number>> = {
		x: useMotionValue(0),
		y: useMotionValue(0),
		rotate: useMotionValue(0),
		scaleX: useMotionValue(1),
		scaleY: useMotionValue(1),
		turn: useMotionValue(0),
	};
	const bodyRef = useRef(body);
	const faceX = useTransform(() => body.turn.get() + lookTurn.get());
	const shadowScale = useTransform(body.y, [-16, 0, 4], [0.62, 1, 1.05]);
	const shadowOpacity = useTransform(body.y, [-16, 0], [0.5, 1]);

	useEffect(() => {
		const node = root.current;
		if (!node) return;
		let intersecting = typeof IntersectionObserver === "undefined";
		const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => {
			setVisible(intersecting && !document.hidden);
			setReducedMotion(preference.matches);
		};
		const observer =
			typeof IntersectionObserver === "undefined"
				? null
				: new IntersectionObserver(([entry]) => {
						intersecting =
							entry.isIntersecting &&
							entry.intersectionRect.width > 0 &&
							entry.intersectionRect.height > 0;
						update();
					});
		observer?.observe(node);
		document.addEventListener("visibilitychange", update);
		preference.addEventListener("change", update);
		update();
		return () => {
			observer?.disconnect();
			document.removeEventListener("visibilitychange", update);
			preference.removeEventListener("change", update);
		};
	}, []);

	// Idle life plus pointer reactions. Idle: a random activity every few
	// seconds. Pointer: eyes follow it anywhere in the window; approaching,
	// hovering the head, clicking it, shaking the pointer, leaving the window
	// and going still each get a reaction. Reduced motion / hidden panel keep
	// the companion still.
	useEffect(() => {
		const values = bodyRef.current;
		const settle = () => {
			for (const [track, value] of Object.entries(values)) {
				value.jump(track.startsWith("scale") ? 1 : 0);
			}
			for (const value of [eyeX, eyeY, lookTurn, tilt]) value.jump(0);
		};
		if (!animate) {
			setExpression("idle");
			settle();
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		let sleepTimer: ReturnType<typeof setTimeout>;
		let running: AnimationPlaybackControls[] = [];
		let current: Act | null = null;
		let last: Act | null = null;
		let hovering = false;
		let near = false;
		let asleep = false;
		let noticedAt = 0;
		let energy = 0;
		let direction = 0;
		let reversals: number[] = [];
		let lastPoint: { x: number; y: number; t: number } | null = null;
		const stop = () => {
			for (const control of running) control.stop();
			running = [];
		};
		const play = (act: Act) => {
			clearTimeout(timer);
			stop();
			current = act;
			last = act;
			setExpression(act.face);
			for (const [track, value] of Object.entries(values) as [
				Track,
				MotionValue<number>,
			][]) {
				const keys = act[track];
				running.push(
					keys
						? animateValue(value, [value.get(), ...keys.slice(1)], {
								duration: act.duration,
								times: act.times,
								ease: "easeInOut",
								repeat: act.loop ? Number.POSITIVE_INFINITY : 0,
							})
						: animateValue(value, track.startsWith("scale") ? 1 : 0, {
								duration: 0.3,
							}),
				);
			}
			if (!act.loop) {
				timer = setTimeout(rest, act.duration * 1000 + between(300, 900));
			}
		};
		const rest = () => {
			if (hovering) {
				play(SHY);
				return;
			}
			stop();
			current = null;
			// Hover can end halfway through SHY; stopping alone freezes that tilt.
			running = Object.entries(values).map(([track, value]) =>
				animateValue(value, track.startsWith("scale") ? 1 : 0, {
					duration: 0.3,
				}),
			);
			setExpression("idle");
			timer = setTimeout(next, between(3000, 7000));
		};
		const next = () => {
			const choices = ACTS.filter((act) => act !== last);
			play(choices[Math.floor(Math.random() * choices.length)]);
		};
		const armSleep = () => {
			clearTimeout(sleepTimer);
			sleepTimer = setTimeout(() => {
				if (hovering || current?.priority) return armSleep();
				asleep = true;
				play(DOZE);
			}, SLEEP_AFTER_MS);
		};
		const headOf = (event: PointerEvent) => {
			const rect = scene.current?.getBoundingClientRect();
			if (!rect?.width || !rect.height) return null;
			const dx = event.clientX - rect.left - rect.width / 2;
			const dy = event.clientY - rect.top - rect.height * 0.45;
			// Head radius: rx 48 of the 180-unit-wide viewBox.
			const radius = rect.width * 0.27;
			return { dx, dy, radius, reach: Math.max(rect.width * 2, 240) };
		};
		const look = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			const head = headOf(event);
			if (!head) return;
			eyeX.set(clamp(head.dx / head.reach) * 6);
			eyeY.set(clamp(head.dy / head.reach) * 4.5);
			lookTurn.set(clamp(head.dx / head.reach) * 4);
			tilt.set(clamp(head.dx / head.reach) * 5);
			armSleep();
			const now = performance.now();
			if (lastPoint) {
				const travel = Math.hypot(
					event.clientX - lastPoint.x,
					event.clientY - lastPoint.y,
				);
				energy = energy * Math.exp(-(now - lastPoint.t) / 400) + travel;
				const step = event.clientX - lastPoint.x;
				if (Math.abs(step) > 4) {
					const sign = Math.sign(step);
					if (direction && sign !== direction) reversals.push(now);
					direction = sign;
				}
				reversals = reversals.filter((at) => now - at < 1000);
			}
			lastPoint = { x: event.clientX, y: event.clientY, t: now };
			if (asleep) {
				asleep = false;
				play(STARTLE);
				return;
			}
			if (
				energy > SHAKE_ENERGY &&
				reversals.length >= SHAKE_REVERSALS &&
				current !== DIZZY
			) {
				energy = 0;
				reversals = [];
				play(DIZZY);
				return;
			}
			const distance = Math.hypot(head.dx, head.dy);
			const over = distance < head.radius;
			const close = distance < head.radius * 3;
			const wasNear = near;
			near = close;
			if (current?.priority) {
				hovering = over;
				return;
			}
			if (over !== hovering) {
				hovering = over;
				if (over) play(SHY);
				else if (current === SHY) rest();
				return;
			}
			if (close && !wasNear && !over && !current && now - noticedAt > 8000) {
				noticedAt = now;
				play(notice(Math.sign(head.dx) || 1));
			}
		};
		const poke = (event: PointerEvent) => {
			const head = headOf(event);
			if (!head || Math.hypot(head.dx, head.dy) >= head.radius) return;
			asleep = false;
			armSleep();
			play(OUCH);
		};
		const leave = () => {
			for (const value of [eyeX, eyeY, lookTurn, tilt]) value.set(0);
			lastPoint = null;
			near = false;
			const wasHovering = hovering;
			hovering = false;
			if (asleep || current?.priority) return;
			if (wasHovering || !current) play(SEARCH);
		};
		const page = document.documentElement;
		window.addEventListener("pointermove", look, { passive: true });
		window.addEventListener("pointerdown", poke, {
			capture: true,
			passive: true,
		});
		page.addEventListener("pointerleave", leave, { passive: true });
		timer = setTimeout(next, between(1500, 3500));
		armSleep();
		return () => {
			clearTimeout(timer);
			clearTimeout(sleepTimer);
			stop();
			settle();
			window.removeEventListener("pointermove", look);
			window.removeEventListener("pointerdown", poke, { capture: true });
			page.removeEventListener("pointerleave", leave);
		};
	}, [animate, eyeX, eyeY, lookTurn, tilt]);

	const eye = `url(#${id}-eye)`;
	return (
		<motion.div
			ref={root}
			className="agent-welcome"
			data-animate={animate}
			aria-live="off"
			aria-hidden={!present || undefined}
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: reducedMotion === false ? 0.12 : 0 }}
		>
			<div className="agent-welcome-content">
				<div ref={scene} className="agent-welcome-scene" aria-hidden="true">
					<motion.div
						className="agent-welcome-shadow-wrap"
						style={{ scale: shadowScale, opacity: shadowOpacity }}
					>
						<span className="agent-welcome-shadow" />
					</motion.div>
					<div className="agent-welcome-float">
						<motion.div
							className="agent-welcome-body"
							style={{
								x: body.x,
								y: body.y,
								rotate: body.rotate,
								scaleX: body.scaleX,
								scaleY: body.scaleY,
								originY: 0.9,
							}}
						>
							<motion.div
								className="agent-welcome-look"
								style={{ rotate: tilt, originY: 0.9 }}
							>
								<svg
									viewBox="10 -5 180 144"
									fill="none"
									aria-hidden="true"
									focusable="false"
								>
									<defs>
										{/* Matte volume lit from the upper left; no gloss. */}
										<radialGradient
											id={`${id}-head`}
											cx="78"
											cy="44"
											r="78"
											gradientUnits="userSpaceOnUse"
										>
											<stop stopColor="#fffefc" />
											<stop offset=".45" stopColor="#f2ede7" />
											<stop offset=".82" stopColor="#d2cac2" />
											<stop offset="1" stopColor="#ada49d" />
										</radialGradient>
										<radialGradient id={`${id}-eye`} cx=".4" cy=".3" r=".9">
											<stop stopColor="#2a2d37" />
											<stop offset="1" stopColor="#15161b" />
										</radialGradient>
										<filter
											id={`${id}-blur`}
											x="-50%"
											y="-50%"
											width="200%"
											height="200%"
										>
											<feGaussianBlur stdDeviation="2.4" />
										</filter>
										{/* The face turns by sliding across the head, clipped to it. */}
										<clipPath id={`${id}-clip`}>
											<ellipse cx="100" cy="72" rx="48" ry="45" />
										</clipPath>
									</defs>
									<ellipse
										cx="100"
										cy="72"
										rx="48"
										ry="45"
										fill={`url(#${id}-head)`}
									/>
									<g clipPath={`url(#${id}-clip)`}>
										<motion.g style={{ x: faceX }}>
											<g
												className="agent-welcome-blush"
												style={{ opacity: BLUSH[expression] }}
											>
												<ellipse
													cx="78"
													cy="83"
													rx="7.5"
													ry="4.2"
													fill="#f29a93"
													filter={`url(#${id}-blur)`}
												/>
												<ellipse
													cx="122"
													cy="83"
													rx="7.5"
													ry="4.2"
													fill="#f29a93"
													filter={`url(#${id}-blur)`}
												/>
											</g>
											<motion.g style={{ x: eyeX, y: eyeY }}>
												<motion.g
													key={expression}
													initial={{ opacity: 0 }}
													animate={{ opacity: 1 }}
													transition={{ duration: 0.12 }}
												>
													<Face expression={expression} eye={eye} />
												</motion.g>
											</motion.g>
										</motion.g>
									</g>
									{expression === "sleepy" ? <Snore /> : null}
								</svg>
							</motion.div>
						</motion.div>
					</div>
				</div>
				{/* One research companion, whichever ACP backend is selected. */}
				<p className="agent-welcome-caption" title={title}>
					<span className="shrink-0">{t("defaultName")}</span>
					<span aria-hidden>·</span>
					<MathText
						text={title}
						className="min-w-0 truncate text-foreground/80"
					/>
				</p>
			</div>
		</motion.div>
	);
}

/** Eyes for one expression; the face never has a mouth. */
function Face({ expression, eye }: { expression: Expression; eye: string }) {
	const stroke = {
		stroke: INK,
		strokeLinecap: "round" as const,
		fill: "none",
	};
	switch (expression) {
		case "shy":
			// Eyes cast down.
			return (
				<>
					<ellipse cx="88" cy="73" rx="5" ry="6.6" fill={eye} />
					<ellipse cx="113" cy="71" rx="5" ry="6.6" fill={eye} />
				</>
			);
		case "ouch":
			return (
				<path
					d="M83 62l9 6-9 6M118 60l-9 6 9 6"
					strokeWidth="3"
					strokeLinejoin="round"
					{...stroke}
				/>
			);
		case "dizzy":
			return (
				<>
					{[
						[88, 68],
						[113, 66],
					].map(([cx, cy]) => (
						<motion.path
							key={cx}
							d={spiral(cx, cy)}
							strokeWidth="2"
							{...stroke}
							style={{ transformBox: "fill-box", transformOrigin: "center" }}
							animate={{ rotate: 360 }}
							transition={{
								duration: 0.9,
								ease: "linear",
								repeat: Number.POSITIVE_INFINITY,
							}}
						/>
					))}
				</>
			);
		case "surprised":
			return (
				<>
					<ellipse cx="88" cy="67" rx="6.4" ry="10.6" fill={eye} />
					<ellipse cx="113" cy="65" rx="6.4" ry="10.6" fill={eye} />
				</>
			);
		case "wink":
			return (
				<>
					<ellipse
						cx="88"
						cy="68"
						rx="5.4"
						ry="9.4"
						fill={eye}
						transform="rotate(-8 88 68)"
					/>
					<path d="M107 67q6-7 12 0" strokeWidth="3" {...stroke} />
				</>
			);
		case "curious":
			return (
				<>
					<ellipse
						cx="93"
						cy="66"
						rx="5.4"
						ry="9.4"
						fill={eye}
						transform="rotate(-8 93 66)"
					/>
					<ellipse
						cx="118"
						cy="63"
						rx="5.4"
						ry="8.4"
						fill={eye}
						transform="rotate(-8 118 63)"
					/>
				</>
			);
		case "sleepy":
			return (
				<path d="M83 71q5 3 10 0M108 69q5 3 10 0" strokeWidth="3" {...stroke} />
			);
		case "thinking":
			return (
				<>
					<ellipse cx="90" cy="64" rx="5" ry="8.6" fill={eye} />
					<ellipse cx="115" cy="62" rx="5" ry="8.6" fill={eye} />
				</>
			);
		default:
			// Level and centred at rest; expressive poses supply their own tilt.
			return (
				<g className="agent-welcome-blink">
					<ellipse cx="87.5" cy="67" rx="5.4" ry="9.4" fill={eye} />
					<ellipse cx="112.5" cy="67" rx="5.4" ry="9.4" fill={eye} />
				</g>
			);
	}
}

/** Two small z's drifting up beside a dozing head. */
function Snore() {
	return (
		<g stroke="#a39b94" strokeWidth="1.8" strokeLinecap="round" fill="none">
			{[0, 0.7].map((delay, index) => (
				<motion.path
					key={delay}
					d={index ? "M141 30h5l-5 6h5" : "M134 40h6l-6 7h6"}
					initial={{ opacity: 0, y: 4 }}
					animate={{ opacity: [0, 1, 0], y: [4, -6, -14] }}
					transition={{
						duration: 1.6,
						delay,
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeOut",
					}}
				/>
			))}
		</g>
	);
}

/** A small spiral eye centred on (cx, cy). */
function spiral(cx: number, cy: number) {
	const points = Array.from({ length: 34 }, (_, index) => {
		const angle = index * 0.55;
		const radius = 0.5 + index * 0.2;
		return `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`;
	});
	return `M${points.join("L")}`;
}
