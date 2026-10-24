#!/usr/bin/env node
// Exercise installed production assets, IPC/SQLite, editor and HTTP MCP.
// Only the native folder picker is substituted with our own temporary fixture.
// No Vite imports or development server are used; never log grant credentials.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

const endpoint = process.env.MARGIN_CDP_URL || "http://127.0.0.1:9431";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname));
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const target = targets.find(
	(x) => x.type === "page" && x.title.includes("Margin"),
);
assert.ok(target, "Start the installed release with WebView2 CDP enabled");
assert.equal(
	new URL(target.url).hostname,
	"tauri.localhost",
	"Not a packaged app",
);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});
let seq = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
	const message = JSON.parse(data);
	if (message.method === "Runtime.exceptionThrown")
		errors.push(message.params.exceptionDetails.text);
	if (
		message.method === "Log.entryAdded" &&
		message.params.entry.level === "error"
	)
		errors.push(message.params.entry.text);
	const task = pending.get(message.id);
	if (!task) return;
	pending.delete(message.id);
	clearTimeout(task.timer);
	if (message.error) task.reject(new Error(message.error.message));
	else task.resolve(message.result);
});
function send(method, params = {}) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`${method} timed out`));
		}, 30000);
		pending.set(id, { resolve, reject, timer });
		socket.send(JSON.stringify({ id, method, params }));
	});
}
async function evaluate(expression) {
	const r = await send("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	});
	if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
	return r.result.value;
}
async function until(expression, message) {
	const end = Date.now() + 30000;
	do {
		if (await evaluate(expression)) return;
		await delay(150);
	} while (Date.now() < end);
	throw new Error(message);
}
const ipc = (command, args = {}) =>
	evaluate(
		`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`,
	);
const tempBase =
	process.env.LOCALAPPDATA &&
	path.join(process.env.LOCALAPPDATA, "Temp", "opencode");
assert.ok(
	tempBase,
	"Run this Windows packaging smoke in the approved temp directory",
);
const root = await fs.mkdtemp(path.join(tempBase, "margin-release-smoke-"));
let reviewId;
let url, bearer, session;
async function request(method, params, notification = false) {
	const id = randomUUID();
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: bearer,
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			...(session ? { "Mcp-Session-Id": session } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			...(notification ? {} : { id }),
			method,
			params,
		}),
		signal: AbortSignal.timeout(10000),
	});
	assert.ok(response.ok, `MCP ${method}: HTTP ${response.status}`);
	const text = await response.text();
	let result;
	if (text.trim()) {
		try {
			result = JSON.parse(text);
		} catch {
			for (const line of text
				.split(/\r?\n/)
				.filter((s) => s.startsWith("data:"))) {
				const message = JSON.parse(line.slice(5));
				if (message.id === id) result = message;
			}
		}
	}
	assert.equal(result?.error, undefined, "MCP protocol error");
	return { response, result: result?.result };
}
async function call(name, args = {}) {
	const { result } = await request("tools/call", { name, arguments: args });
	assert.notEqual(result.isError, true, JSON.stringify(result));
	return result.structuredContent;
}
try {
	await send("Runtime.enable");
	await send("Log.enable");
	await send("Page.bringToFront");
	const csp = await evaluate(
		`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content`,
	);
	assert.ok(
		csp?.includes("object-src 'none'") && !csp.includes("'unsafe-eval'"),
		"Missing release CSP",
	);
	await evaluate(`(() => {
		const original=window.__TAURI_INTERNALS__.invoke;
		window.__marginSmokeRestore=()=>{window.__TAURI_INTERNALS__.invoke=original;};
		window.__TAURI_INTERNALS__.invoke=(cmd,args,...rest)=>cmd==='plugin:dialog|open'?Promise.resolve(${JSON.stringify(root)}):original(cmd,args,...rest);
		document.querySelector('aside button').click();
	})()`);
	await until(
		`!!document.querySelector('aside input')`,
		"Workspace picker action failed",
	);
	await evaluate(
		`window.__marginSmokeRestore(); delete window.__marginSmokeRestore;`,
	);
	const created = await ipc("margin_create", {
		vaultPath: root,
		title: "Release smoke manuscript",
	});
	assert.equal(created.ok, true);
	reviewId = created.data.id;
	const context = { vaultPath: root, reviewId };
	const command = (request) =>
		ipc("margin_command", { ...context, commandId: randomUUID(), request });
	const initial = (await ipc("margin_open", context)).data;
	const saved = await command({
		kind: "save",
		expectedHead: initial.headId,
		lastSaved: initial.manuscript,
		markdown: "# Packaged review\n\nA cautious conclusion.\n",
	});
	assert.equal(saved.ok, true, JSON.stringify(saved));
	// Re-open using the real picker callback so its real list includes our fixture.
	await evaluate(
		`(() => {const original=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(cmd,args,...rest)=>{if(cmd==='plugin:dialog|open'){window.__TAURI_INTERNALS__.invoke=original;return Promise.resolve(${JSON.stringify(root)});}return original(cmd,args,...rest);};document.querySelector('aside button').click();})()`,
	);
	await until(
		`!!document.querySelector('nav button')`,
		"Created manuscript missing from UI",
	);
	await evaluate(`document.querySelector('nav button').click()`);
	await until(
		`!!document.querySelector('[data-slate-editor="true"]')`,
		"Packaged editor did not load",
	);
	await evaluate(
		`(() => {const editor=document.querySelector('[data-slate-editor="true"]');editor.focus();const r=document.createRange();r.selectNodeContents(editor);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`,
	);
	await send("Input.insertText", { text: " Saved from the installed editor." });
	await until(
		`(async()=>(await window.__TAURI_INTERNALS__.invoke('margin_open',${JSON.stringify(context)})).data.manuscript.includes('Saved from the installed editor.'))()`,
		"Production editor autosave failed",
	);
	const grant = await ipc("margin_ai_start", {
		...context,
		label: "Release Smoke AI",
	});
	url = grant.url;
	bearer = grant.config.mcpServers.margin.headers.Authorization;
	assert.equal((await fetch(url)).status, 401);
	const initialized = await request("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "Not the author identity", version: "1" },
	});
	session = initialized.response.headers.get("mcp-session-id");
	await request("notifications/initialized", undefined, true);
	assert.equal((await request("tools/list")).result.tools.length, 7);
	const read = await call("review_read");
	assert.equal(read.you.name, "Release Smoke AI");
	const commandId = randomUUID();
	const proposal = {
		commandId,
		baseRevision: read.headId,
		markdown: read.manuscript.replace(
			"cautious conclusion",
			"carefully qualified conclusion",
		),
	};
	const made = await call("review_propose", proposal);
	const retried = await call("review_propose", proposal);
	assert.equal(made.commandResult.proposalId, retried.commandResult.proposalId);
	assert.equal(
		(await call("review_read")).headId,
		read.headId,
		"AI proposal overwrote text",
	);
	const proposalId = made.commandResult.proposalId;
	const pendingView = (await ipc("margin_open", context)).data;
	const applied = await command({
		kind: "apply-proposal",
		proposalId,
		expectedStamp: pendingView.stamp,
	});
	assert.equal(applied.ok, true, JSON.stringify(applied));
	assert.equal(
		applied.data.baselineText,
		read.baselineText,
		"Application accepted the baseline",
	);
	assert.ok(applied.data.manuscript.includes("carefully qualified conclusion"));
	const updates = await call("review_updates", { after: 0 });
	assert.ok(updates.events.length > 0);
	await until(
		`document.querySelector('[data-slate-editor="true"]')?.textContent.includes('carefully qualified conclusion')`,
		"Applied proposal did not reload in editor",
	);
	await ipc("margin_ai_stop");
	assert.equal((await ipc("margin_ai_status")).listening, false);
	let revoked = false;
	try {
		const r = await fetch(url, {
			headers: { Authorization: bearer },
			signal: AbortSignal.timeout(3000),
		});
		revoked = !r.ok;
	} catch {
		revoked = true;
	}
	assert.ok(revoked, "Revoked MCP remained accessible");
	for (const oldCommand of [
		"get_settings",
		"mcp_server_status",
		"vault_list",
	]) {
		await assert.rejects(
			ipc(oldCommand),
			"Old workbench command unexpectedly exposed",
		);
	}
	const pdf = await PDFDocument.create();
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	pdf.addPage().drawText("Margin packaged PDF parsing fixture.", {
		x: 40,
		y: 700,
		font,
		size: 14,
	});
	const pdfPath = path.join(root, "fixture.pdf");
	await fs.writeFile(pdfPath, await pdf.save());
	const imported = await ipc("margin_import", {
		vaultPath: root,
		filePaths: [pdfPath],
	});
	assert.equal(imported.ok, true, JSON.stringify(imported));
	const parsed = await ipc("margin_parse_pdf", {
		vaultPath: root,
		reviewId: imported.data[0].id,
	});
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	assert.ok(
		parsed.data.manuscript.includes("Margin packaged PDF parsing fixture"),
		"Bundled PDFium worker failed",
	);
	assert.deepEqual(errors, [], "Production runtime/CSP errors");
	await fs.mkdir("artifacts", { recursive: true });
	const screenshot = await send("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(
		"artifacts/margin-release-smoke.png",
		Buffer.from(screenshot.data, "base64"),
	);
	console.log(
		"Installed release passed: production CSP/assets, real editor autosave, SQLite, seven scoped MCP tools, idempotent pending proposal, human application, baseline preservation, UI reload, revocation, legacy IPC isolation and bundled PDFium subprocess parsing.",
	);
} finally {
	await ipc("margin_ai_stop").catch(() => {});
	await evaluate(
		`window.__marginSmokeRestore?.(); delete window.__marginSmokeRestore;`,
	).catch(() => {});
	socket.close();
	// Remove only the fixture directory created by this invocation.
	await fs.rm(root, { recursive: true, force: true });
}
