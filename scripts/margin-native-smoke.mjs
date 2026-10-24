#!/usr/bin/env node
// Drive a real debug WebView2 window. Call the same workspace-open action as
// the picker; review commands, storage, editor input and exports remain real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runSingleAiCheckpoint } from "./margin-ai-checkpoint.mjs";

const endpoint = process.env.MARGIN_CDP_URL || "http://127.0.0.1:9431";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname));
// Page.bringToFront only activates the WebView target, not its native window.
// Restore the dedicated Margin test window so real animation-frame layout runs.
function restoreWindow() {
	if (process.platform === "win32") {
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`
Add-Type @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class MarginSmokeWindow {
 public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc fn, IntPtr param);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int mode);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 public static void Restore() {
  EnumWindows((hwnd,p)=>{
   var title=new StringBuilder(256); GetWindowText(hwnd,title,256);
   if(title.ToString().StartsWith("Margin")) {
    uint pid; GetWindowThreadProcessId(hwnd,out pid);
     if(Process.GetProcessById((int)pid).ProcessName=="margin") {ShowWindowAsync(hwnd,9);SetForegroundWindow(hwnd);}
   }
   return true;
  },IntPtr.Zero);
 }
}
'@
[MarginSmokeWindow]::Restore()
`,
			],
			{ windowsHide: true, timeout: 15000 },
		);
	}
}
restoreWindow();
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find(
	(x) => x.type === "page" && x.title.includes("Margin"),
);
assert.ok(
	target,
	"Start the Margin debug desktop app with WebView2 CDP enabled",
);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === "Runtime.exceptionThrown")
		errors.push(message.params.exceptionDetails.text);
	const task = pending.get(message.id);
	if (!task) return;
	pending.delete(message.id);
	clearTimeout(task.timer);
	if (message.error) task.reject(new Error(message.error.message));
	else task.resolve(message.result);
});
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 30000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const result = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (result.exceptionDetails)
		throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
}
async function until(expression, message) {
	const end = Date.now() + 30000;
	do {
		if (await evaluate(`(async () => Boolean(await (${expression})))()`))
			return;
		await delay(150);
	} while (Date.now() < end);
	throw new Error(
		`${message}\n${await evaluate("document.body.innerText")}\nvisibility=${await evaluate("document.visibilityState")}\n${JSON.stringify(errors)}`,
	);
}
async function ipc(command, args) {
	return evaluate(
		`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
	);
}
async function mutate(id, request, commandId = randomUUID()) {
	return ipc("margin_command", {
		vaultPath: root,
		reviewId: id,
		commandId,
		request,
	});
}
async function current() {
	const result = await ipc("margin_open", {
		vaultPath: root,
		reviewId: documentId,
	});
	assert.equal(result.ok, true, JSON.stringify(result));
	return result.data.manuscript;
}
async function clickReview(key) {
	await until(
		`(async () => {
		const {default: i18n} = await import('/src/i18n/index.ts');
		const label = i18n.t(${JSON.stringify(`review:${key}`)});
		return [...document.querySelectorAll('button')].some(x => (x.title === label || x.getAttribute('aria-label') === label) && !x.disabled);
	})()`,
		`Review action unavailable: ${key}`,
	);
	await evaluate(`(async () => {
		const {default: i18n} = await import('/src/i18n/index.ts');
		const label = i18n.t(${JSON.stringify(`review:${key}`)});
		const button = [...document.querySelectorAll('button')].find(x => x.title === label || x.getAttribute('aria-label') === label);
		if (!button) throw new Error('Missing review action: ' + label);
		button.click();
	})()`);
}
async function typeAtEnd(text) {
	await evaluate(`(() => {
		const editor = document.querySelector('[data-slate-editor="true"]');
		editor.focus();
		const range = document.createRange();
		range.selectNodeContents(editor);
		range.collapse(false);
		getSelection().removeAllRanges();
		getSelection().addRange(range);
	})()`);
	await send("Input.insertText", { text });
}
async function clickChangeCard(key) {
	await evaluate(`(async () => {
		const {default: i18n} = await import('/src/i18n/index.ts');
		const label = i18n.t(${JSON.stringify(`review:toolbar.${key}`)});
		const card = document.querySelector('[data-review-comment-id^="chg-"]');
		const button = [...(card?.querySelectorAll('button') ?? [])].find(x => x.title === label);
		if (!button || button.disabled) throw new Error('Missing or disabled change-card action: ' + label);
		button.click();
	})()`);
}
async function setDarkMode(dark) {
	if (
		(await evaluate("document.documentElement.classList.contains('dark')")) ===
		dark
	)
		return;
	await evaluate(`(async () => {
		const label = (await import('/src/i18n/index.ts')).default.t('margin:theme');
		[...document.querySelectorAll('header button')].find(x => x.getAttribute('aria-label') === label).click();
	})()`);
	await until(
		`document.documentElement.classList.contains('dark') === ${dark}`,
		"Theme did not update",
	);
	// Capture the settled theme, not a frame halfway through color transitions.
	await delay(250);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "margin-next-smoke-"));
const source =
	"# Fictional study\n\nThe evidence supports a cautious conclusion.\n";
const input = path.join(root, "fictional.md");
await fs.writeFile(input, source);
let documentId;
let initialDark;
let initialTheme;
try {
	await send("Runtime.enable");
	await send("Page.bringToFront");
	await until(
		`document.visibilityState === 'visible'`,
		"Restore the Margin desktop window before running native layout tests",
	);
	await send("Page.reload");
	await until(
		`document.querySelector('header')?.innerText.includes('Margin')`,
		"Desktop shell did not boot",
	);
	initialDark = await evaluate(
		"document.documentElement.classList.contains('dark')",
	);
	initialTheme = await evaluate("localStorage.getItem('margin-next.theme')");
	await assert.rejects(
		ipc("vault_ensure", { path: root, locale: "en" }),
		"The research-workbench command must not be registered",
	);
	assert.equal(
		(await ipc("margin_list", { vaultPath: root })).ok,
		false,
		"Document API must reject unopened workspaces",
	);
	await ipc("margin_open_workspace", { path: root });
	const imported = await ipc("margin_import", {
		vaultPath: root,
		filePaths: [input],
	});
	assert.equal(imported.ok, true, JSON.stringify(imported));
	const unit = imported.data[0];
	documentId = unit.id;
	assert.equal(
		(await fs.readdir(root)).includes("reviews"),
		false,
		"New backend must not create legacy storage",
	);
	await evaluate(
		`(async () => {
			// Use the same Vite revision as the mounted shell, including HMR stamps.
			const source = await (await fetch('/src/margin/margin-app.tsx')).text();
			const line = source.split(String.fromCharCode(10)).find(x => x.includes('/src/margin/workspace.ts'));
			const ref = line?.match(/["']([^"']+)["']/);
			if (!ref) throw new Error('Cannot resolve the workspace module');
			const {openMarginWorkspace} = await import(ref[1]);
			await openMarginWorkspace(${JSON.stringify(root)});
		})()`,
	);
	await until(
		`document.querySelector('nav button')`,
		"Workspace list did not load",
	);
	await evaluate(`document.querySelector('nav button').click()`);
	await until(
		`document.querySelector('[data-slate-editor="true"]')`,
		"Edda review editor did not mount",
	);
	assert.equal(
		(await fs.readdir(root)).includes(".edda"),
		false,
		"Review-only open must not create a catalog",
	);
	const initialDocument = await ipc("margin_open", {
		vaultPath: root,
		reviewId: unit.id,
	});
	await evaluate(
		`(() => { const editor = document.querySelector('[data-slate-editor="true"]'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`,
	);
	await send("Input.insertText", { text: " Added by the author." });
	const proposalRequest = {
		kind: "propose",
		baseRevision: initialDocument.data.headId,
		markdown: source.replace("supports", "suggests"),
		agent: "Smoke Agent",
	};
	const proposalCommand = randomUUID();
	const pendingProposal = await mutate(
		unit.id,
		proposalRequest,
		proposalCommand,
	);
	assert.equal(pendingProposal.ok, true, JSON.stringify(pendingProposal));
	assert.equal(
		pendingProposal.data.headId,
		initialDocument.data.headId,
		"A pending proposal must not replace the author's draft base",
	);
	assert.equal(
		(await mutate(unit.id, proposalRequest, proposalCommand)).data
			.acknowledgedSequence,
		pendingProposal.data.sequence,
		"Retries must not duplicate a proposal",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-slate-editor]').textContent.includes('Added by the author')`,
		),
		true,
	);
	// Original is a separate read-only surface: even an unflushed author edit
	// must survive a display switch without reseeding/remounting the live editor.
	await evaluate(
		`(() => { window.__marginSmokeEditor = document.querySelector('[data-slate-editor="true"]'); return true; })()`,
	);
	await clickReview("toolbar.showOriginal");
	await until(
		`document.querySelector('[data-review-original] [data-slate-editor]')`,
		"Original preview did not mount",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-review-original] [data-slate-editor]').contentEditable`,
		),
		"false",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-review-original]').innerText.includes('Added by the author')`,
		),
		false,
	);
	await clickReview("toolbar.showClean");
	await until(
		`!document.querySelector('[data-review-change]')`,
		"Final text still shows revision marks",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-slate-editor="true"]') === window.__marginSmokeEditor`,
		),
		true,
	);
	assert.equal(
		await evaluate(
			`window.__marginSmokeEditor.textContent.includes('Added by the author')`,
		),
		true,
	);
	await clickReview("toolbar.showMarkup");
	await until(
		`(async () => document.querySelector('header [role="status"]')?.textContent === (await import('/src/i18n/index.ts')).default.t('margin:saved'))()`,
		"Author edit did not finish saving",
	);
	// The status may still be clean in the same frame as input; the disk is
	// authoritative, and the native IPC reads it under the review lock.
	await until(
		`(async () => { const x = await window.__TAURI_INTERNALS__.invoke('margin_open', {vaultPath:${JSON.stringify(root)}, reviewId:${JSON.stringify(unit.id)}}); return x.ok && x.data.events.some(e => e.kind === 'edit'); })()`,
		"No native edit history was recorded",
	);
	assert.match(await current(), /Added by the author/);
	const savedDocument = await ipc("margin_open", {
		vaultPath: root,
		reviewId: unit.id,
	});
	const staleProposal = await mutate(unit.id, {
		kind: "apply-proposal",
		expectedStamp: savedDocument.data.stamp,
		proposalId: pendingProposal.data.commandResult.proposalId,
	});
	assert.equal(
		staleProposal.ok,
		false,
		"A stale-base proposal must not replace newer author text",
	);
	assert.equal(
		(
			await ipc("margin_revision", {
				vaultPath: root,
				reviewId: unit.id,
				revisionId: initialDocument.data.headId,
			})
		).data,
		source,
		"Earlier revisions must remain unchanged",
	);
	await until(
		`document.querySelector('[data-review-change]')`,
		"Tracked decorations did not appear",
	);
	await clickReview("toolbar.acceptAll");
	await until(
		`!document.querySelector('[data-review-change]')`,
		"Accept-all did not clear tracked decorations",
	);
	const view = await ipc("margin_open", {
		vaultPath: root,
		reviewId: unit.id,
		knownBaseline: null,
	});
	assert.equal(view.ok, true);
	assert.match(view.data.baselineText, /Added by the author/);
	const acceptedText = await current();
	await evaluate(
		`(() => { const editor = document.querySelector('[data-slate-editor="true"]'); editor.focus(); const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`,
	);
	await send("Input.insertText", { text: " Remove this revision." });
	await until(
		`document.querySelector('[data-review-change]')`,
		"Second edit was not tracked",
	);
	await until(
		`(async () => document.querySelector('header [role="status"]')?.textContent === (await import('/src/i18n/index.ts')).default.t('margin:saved'))()`,
		"Second edit did not save",
	);
	await clickReview("toolbar.rejectAll");
	await until(
		`!document.querySelector('[data-review-change]')`,
		"Reject-all did not restore the baseline",
	);
	assert.equal(await current(), acceptedText);
	// Individual decisions live beside their revision, not only in the ribbon.
	await typeAtEnd(" Review this single change.");
	await until(
		`document.querySelector('.review-change-insert')`,
		"Individual revision did not appear",
	);
	await clickReview("toolbar.nextItem");
	await until(
		`document.querySelector('[data-review-comment-id^="chg-"] button:not(:disabled)[title]')`,
		"Selected revision card did not appear",
	);
	await until(
		`(async () => { const label = (await import('/src/i18n/index.ts')).default.t('review:toolbar.rejectChange'); return [...document.querySelectorAll('[data-review-comment-id^="chg-"] button')].some(x => x.title === label && !x.disabled); })()`,
		"Revision decision did not wait for autosave",
	);
	await clickChangeCard("rejectChange");
	await until(
		`!document.querySelector('[data-review-change]')`,
		"Individual rejection did not restore the text",
	);
	await until(
		`(async () => document.querySelector('header [role="status"]')?.textContent === (await import('/src/i18n/index.ts')).default.t('margin:saved'))()`,
		"Individual rejection did not save",
	);
	assert.equal(await current(), acceptedText);
	await typeAtEnd(" Accepted individually.");
	await until(
		`document.querySelector('.review-change-insert')`,
		"Second individual revision did not appear",
	);
	await clickReview("toolbar.nextItem");
	await until(
		`(async () => { const label = (await import('/src/i18n/index.ts')).default.t('review:toolbar.acceptChange'); return [...document.querySelectorAll('[data-review-comment-id^="chg-"] button')].some(x => x.title === label && !x.disabled); })()`,
		"Individual accept action unavailable",
	);
	await clickChangeCard("acceptChange");
	await until(
		`!document.querySelector('[data-review-change]')`,
		"Individual acceptance did not clear the revision",
	);
	assert.match(
		(
			await ipc("margin_open", {
				vaultPath: root,
				reviewId: unit.id,
				knownBaseline: null,
			})
		).data.baselineText,
		/Accepted individually/,
	);
	const beforeComment = await ipc("margin_open", {
		vaultPath: root,
		reviewId: unit.id,
	});
	const comment = await mutate(unit.id, {
		kind: "comment-add",
		expectedHead: beforeComment.data.headId,
		input: {
			blockId: null,
			quote: "cautious conclusion",
			prefix: "",
			suffix: "",
			heading: "Fictional study",
			body: "Check the uncertainty interval.",
		},
	});
	assert.equal(comment.ok, true, JSON.stringify(comment));
	await until(
		`document.body.innerText.includes('Check the uncertainty interval.')`,
		"External native comment did not appear in margin",
	);
	const thread = comment.data.comments[0];
	const reply = await mutate(unit.id, {
		kind: "comment-update",
		commentId: thread.id,
		action: "reply",
		body: "Interval checked against the fictional data.",
		expectedUpdatedAt: thread.updatedAt,
		replyId: null,
	});
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.equal(reply.data.comments[0].replies.length, 1);
	// Resizing / original preview must not unmount an in-progress reply.
	await evaluate(`(() => {
		const card = document.querySelector('[data-review-comment-id="${thread.id}"]');
		card.querySelector('button').click();
	})()`);
	await until(
		`document.querySelector('[data-review-comment-id="${thread.id}"] button[title]')`,
		"Comment did not expand",
	);
	await evaluate(`(async () => {
		const label = (await import('/src/i18n/index.ts')).default.t('review:card.reply');
		[...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].find(x => x.title === label).click();
	})()`);
	await until(
		`document.querySelector('[data-review-comment-id="${thread.id}"] textarea')`,
		"Reply composer did not open",
	);
	await evaluate(
		`(() => { window.__marginSmokeReply = document.querySelector('[data-review-comment-id="${thread.id}"] textarea'); window.__marginSmokeReply.focus(); return true; })()`,
	);
	await send("Input.insertText", { text: "Draft retained across views." });
	await clickReview("toolbar.showOriginal");
	await until(
		`document.querySelector('[data-review-original] [data-slate-editor]')`,
		"Reply test original preview did not mount",
	);
	await clickReview("toolbar.showMarkup");
	await until(
		`!document.querySelector('[data-review-original]')`,
		"Reply test did not return to markup",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-review-comment-id="${thread.id}"] textarea') === window.__marginSmokeReply && window.__marginSmokeReply.value === 'Draft retained across views.'`,
		),
		true,
	);
	await send("Emulation.setDeviceMetricsOverride", {
		width: 860,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await until(
		`document.querySelector('.review-rail[data-compact="true"]')`,
		"Reply rail did not adapt to narrow layout",
	);
	assert.equal(
		await evaluate(
			`document.querySelector('[data-review-comment-id="${thread.id}"] textarea') === window.__marginSmokeReply && window.__marginSmokeReply.value === 'Draft retained across views.'`,
		),
		true,
	);
	await send("Emulation.clearDeviceMetricsOverride");
	await until(
		`document.querySelector('.review-rail[data-compact="false"]')`,
		"Wide rail did not restore",
	);
	await evaluate(`(async () => {
		const label = (await import('/src/i18n/index.ts')).default.t('review:composer.cancel');
		[...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].find(x => x.textContent === label).click();
	})()`);
	// Reply editing/deletion must carry the thread version, not bypass CAS.
	await evaluate(
		`document.querySelector('[data-review-comment-id="${thread.id}"] button').click()`,
	);
	await until(
		`(async () => {const label=(await import('/src/i18n/index.ts')).default.t('review:card.editReply');return [...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].some(x=>x.title===label);})()`,
		"Reply actions did not expand",
	);
	await evaluate(`(async () => {
		const label=(await import('/src/i18n/index.ts')).default.t('review:card.editReply');
		[...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].find(x=>x.title===label).click();
	})()`);
	await until(
		`document.querySelector('[data-review-comment-id="${thread.id}"] textarea')`,
		"Reply edit did not open",
	);
	await evaluate(
		`(() => {const area=document.querySelector('[data-review-comment-id="${thread.id}"] textarea');area.focus();area.setSelectionRange(0,area.value.length);})()`,
	);
	await send("Input.insertText", {
		text: "Updated reply through the document service.",
	});
	await evaluate(
		`document.querySelector('[data-review-comment-id="${thread.id}"] textarea').blur()`,
	);
	await until(
		`!document.querySelector('[data-review-comment-id="${thread.id}"] textarea')`,
		"Reply edit was not acknowledged",
	);
	let editedThread = (
		await ipc("margin_open", { vaultPath: root, reviewId: unit.id })
	).data.comments.find((c) => c.id === thread.id);
	assert.equal(
		editedThread.replies[0].body,
		"Updated reply through the document service.",
	);
	await evaluate(`(async () => {
		const label=(await import('/src/i18n/index.ts')).default.t('review:card.deleteReply');
		[...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].find(x=>x.title===label).click();
	})()`);
	await evaluate(`(async () => {
		const label=(await import('/src/i18n/index.ts')).default.t('review:card.delete');
		[...document.querySelectorAll('[data-review-comment-id="${thread.id}"] button')].find(x=>x.textContent===label).click();
	})()`);
	await until(
		`!document.querySelector('[data-review-comment-id="${thread.id}"]').innerText.includes('Updated reply through')`,
		"Reply deletion was not acknowledged",
	);
	editedThread = (
		await ipc("margin_open", { vaultPath: root, reviewId: unit.id })
	).data.comments.find((c) => c.id === thread.id);
	assert.equal(editedThread.replies.length, 0);
	const exportDir = path.join(root, "export");
	await fs.mkdir(exportDir);
	const exported = await ipc("margin_export", {
		vaultPath: root,
		reviewId: unit.id,
		destDir: exportDir,
	});
	assert.equal(exported.ok, true, JSON.stringify(exported));
	assert.ok((await fs.readdir(exported.data)).includes("review.json"));
	assert.ok((await fs.readdir(exported.data)).includes("review.sqlite"));
	await assert.rejects(
		fs.access(unit.manuscriptPath),
		"Live manuscript must not have a second file authority",
	);
	const blocked = await mutate(unit.id, {
		kind: "save",
		expectedHead: beforeComment.data.headId,
		markdown: "must not write",
		lastSaved: "stale",
		anchors: null,
	});
	assert.equal(
		blocked.ok,
		false,
		"Stale saves must be rejected by the real Host",
	);
	assert.notEqual(await current(), "must not write");
	// A real replacement exercises red deletion + green insertion together.
	await evaluate(`(() => {
		const editor = document.querySelector('[data-slate-editor="true"]');
		const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
		while (walker.nextNode()) {
			const text = walker.currentNode;
			const at = text.textContent.indexOf('supports');
			if (at < 0 || text.parentElement.closest('del')) continue;
			const range = document.createRange();
			range.setStart(text, at); range.setEnd(text, at + 8);
			editor.focus(); getSelection().removeAllRanges(); getSelection().addRange(range);
			return;
		}
		throw new Error('Replacement fixture not found');
	})()`);
	await send("Input.insertText", { text: "suggests" });
	await until(
		`document.querySelector('.review-change-delete') && document.querySelector('.review-change-insert')`,
		"Replacement lacks distinct deletion and insertion marks",
	);
	await clickReview("toolbar.nextItem");
	await until(
		`document.querySelector('[data-review-comment-id^="chg-"]')`,
		"Replacement card unavailable",
	);
	await fs.mkdir("artifacts", { recursive: true });
	// Capture the Chinese interface too; the preceding workflow uses the host locale.
	await evaluate(
		`import('/src/i18n/index.ts').then(({default: i18n}) => i18n.changeLanguage('zh-CN')).then(() => true)`,
	);
	await setDarkMode(false);
	if (process.platform === "win32")
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				"scripts/margin-window-smoke.ps1",
				"-Label",
				"window-review-light",
			],
			{ windowsHide: true, timeout: 20000 },
		);
	const capture = await send("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(
		"artifacts/margin-native-review.png",
		Buffer.from(capture.data, "base64"),
	);
	await setDarkMode(true);
	if (process.platform === "win32")
		execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				"scripts/margin-window-smoke.ps1",
				"-Label",
				"window-review-dark",
			],
			{ windowsHide: true, timeout: 20000 },
		);
	const dark = await send("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(
		"artifacts/margin-review-dark.png",
		Buffer.from(dark.data, "base64"),
	);
	await setDarkMode(false);
	await send("Emulation.setDeviceMetricsOverride", {
		width: 860,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await until(
		`document.querySelector('.review-rail[data-compact="true"]')`,
		"Narrow review rail did not stack below the document",
	);
	assert.equal(
		await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
		true,
		"Narrow review overflows horizontally",
	);
	const narrow = await send("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(
		"artifacts/margin-review-compact.png",
		Buffer.from(narrow.data, "base64"),
	);
	await send("Emulation.clearDeviceMetricsOverride");
	const savedManuscript = await current();
	assert.match(savedManuscript, /suggests/);
	assert.doesNotMatch(savedManuscript, /<\/?(?:ins|del)\b/);
	await runSingleAiCheckpoint({
		evaluate,
		send,
		until,
		ipc,
		root,
		reviewId: unit.id,
		clickReview,
		typeAtEnd,
		restoreWindow,
	});
	assert.deepEqual(
		errors,
		[],
		"No uncaught exceptions in the review-only shell",
	);
	console.log(
		"Margin native smoke passed: isolated Host, import, draft-safe original/final/markup views, inline replacement, per-card and bulk accept/reject, comments/replies, narrow layout, export and stale-save rejection.",
	);
} finally {
	await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
	if (initialDark !== undefined) await setDarkMode(initialDark).catch(() => {});
	if (initialTheme !== undefined)
		await evaluate(
			`(() => { ${initialTheme === null ? "localStorage.removeItem('margin-next.theme')" : `localStorage.setItem('margin-next.theme', ${JSON.stringify(initialTheme)})`}; return true; })()`,
		).catch(() => {});
	// Leave the running app at its welcome page before removing our own fixture.
	await send("Page.reload").catch(() => {});
	socket.close();
	// WebView navigation can leave a last read-only SQLite task finishing on
	// Windows. Retry fixture cleanup without touching any user workspace.
	await fs.rm(root, {
		recursive: true,
		force: true,
		maxRetries: 20,
		retryDelay: 100,
	});
}
