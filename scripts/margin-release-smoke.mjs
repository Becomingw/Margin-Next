#!/usr/bin/env node
// Exercise installed production assets, IPC/SQLite, editor and HTTP MCP.
// Drive the real native folder picker into our own temporary fixture directory.
// No Vite imports or development server are used; never log grant credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const processId = Number(process.env.MARGIN_TEST_PID);
assert.ok(
	Number.isSafeInteger(processId) && processId > 0,
	"Set MARGIN_TEST_PID to the dedicated installed test process",
);
function pickWorkspace(path, cancel = false) {
	execFileSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			"scripts/margin-pick-workspace.ps1",
			"-ProcessId",
			String(processId),
			...(cancel ? ["-Cancel"] : ["-Path", path]),
		],
		{ windowsHide: true, timeout: 20000 },
	);
}
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
				const data = line.slice(5).trim();
				if (!data) continue;
				const message = JSON.parse(data);
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
		`(async()=>document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || (await fetch(location.href)).headers.get('content-security-policy'))()`,
	);
	assert.ok(
		csp?.includes("object-src 'none'") && !csp.includes("'unsafe-eval'"),
		"Missing release CSP",
	);
	await evaluate(`document.querySelector('aside button').click()`);
	pickWorkspace(root);
	await until(
		`(async()=>!document.querySelector('aside button').disabled && (await window.__TAURI_INTERNALS__.invoke('margin_list',{vaultPath:${JSON.stringify(root)}})).ok)()`,
		"Workspace picker action failed",
	);
	const created = await ipc("margin_create", {
		vaultPath: root,
		title: "Release smoke manuscript",
	});
	assert.equal(created.ok, true, JSON.stringify(created));
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
	// Re-open through the native picker to refresh the real manuscript list.
	await evaluate(`document.querySelector('aside button').click()`);
	pickWorkspace(root);
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
	const blank = await PDFDocument.create();
	blank.addPage();
	blank.addPage();
	const blankPath = path.join(root, "blank.pdf");
	await fs.writeFile(blankPath, await blank.save());
	const blankImport = await ipc("margin_import", {
		vaultPath: root,
		filePaths: [blankPath],
	});
	assert.equal(blankImport.ok, true, JSON.stringify(blankImport));
	const blankContext = { vaultPath: root, reviewId: blankImport.data[0].id };
	const beforeBlank = (await ipc("margin_open", blankContext)).data;
	const noText = await ipc("margin_parse_pdf", blankContext);
	assert.equal(
		noText.ok,
		false,
		"Blank PDF should not produce a usable manuscript",
	);
	assert.equal(noText.error.code, "pdf_needs_ocr", JSON.stringify(noText));
	assert.equal(
		(await ipc("margin_open", blankContext)).data.headId,
		beforeBlank.headId,
		"Failed extraction changed the manuscript",
	);
	assert.deepEqual(errors, [], "Production runtime/CSP errors");
	await fs.mkdir("artifacts", { recursive: true });
	const screenshot = await send("Page.captureScreenshot", { format: "png" });
	await fs.writeFile(
		"artifacts/margin-release-smoke.png",
		Buffer.from(screenshot.data, "base64"),
	);
	console.log(
		"Installed release passed: production CSP/assets, real editor autosave, SQLite, seven scoped MCP tools, idempotent pending proposal, human application, baseline preservation, UI reload, revocation, legacy IPC isolation, bundled PDFium text extraction and safe rejection of a textless PDF.",
	);
} finally {
	await ipc("margin_ai_stop").catch(() => {});
	socket.close();
	// Remove only the fixture directory created by this invocation.
	await fs.rm(root, { recursive: true, force: true });
}
