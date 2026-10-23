import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

/** Extends the real WebView smoke fixture. Only editor save delivery is delayed:
 * every storage write still reaches the actual Host/SQLite implementation. */
export async function runSingleAiCheckpoint({
	evaluate,
	send,
	until,
	ipc,
	root,
	reviewId,
	clickReview,
	typeAtEnd,
	restoreWindow,
}) {
	const ensureVisible = async () => {
		if (await evaluate(`document.visibilityState !== 'visible'`))
			restoreWindow();
		await until(
			`document.visibilityState === 'visible'`,
			"Restore the Margin window for the AI checkpoint",
		);
	};
	const key = async (name) => {
		const label = await evaluate(
			`import('/src/i18n/index.ts').then(({default:i18n})=>i18n.t(${JSON.stringify(name)}))`,
		);
		assert.notEqual(
			label,
			name.split(":").at(-1),
			`Missing translation: ${name}`,
		);
		return label;
	};
	const click = async (name, scope = "document") => {
		await ensureVisible();
		const label = await key(name);
		await until(
			`(() => {const scope=${scope};return [...scope.querySelectorAll('button')].some(b=>(b.title===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})&&!b.disabled);})()`,
			`Missing enabled action: ${name}`,
		);
		await evaluate(
			`(() => {const scope=${scope};[...scope.querySelectorAll('button')].find(b=>(b.title===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent.trim()===${JSON.stringify(label)})&&!b.disabled).click();})()`,
		);
	};
	const dialog = `document.querySelector('[role="dialog"]')`;
	const open = async () => {
		await click("margin:ai.title");
		await until(
			`document.querySelector('[role="dialog"]')`,
			"AI dialog did not open",
		);
	};
	const close = async () => {
		await until(
			`document.querySelector('[role="dialog"] [data-slot="dialog-close"]')`,
			"AI action did not settle",
		);
		await evaluate(
			`document.querySelector('[role="dialog"] [data-slot="dialog-close"]').click()`,
		);
		await until(
			`!document.querySelector('[role="dialog"]')`,
			"AI dialog did not close",
		);
	};
	const preview = async (pid) => {
		await ensureVisible();
		await until(
			`document.querySelector('[data-margin-proposal-id="${pid}"] > button:not(:disabled)')`,
			"AI proposal did not reach the UI",
		);
		await evaluate(
			`document.querySelector('[data-margin-proposal-id="${pid}"] > button').click()`,
		);
		await until(
			`document.querySelector('[data-margin-proposal-id="${pid}"] pre')`,
			"Proposal preview did not load",
		);
	};
	let url, bearer, session;
	async function request(body) {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: bearer,
				Accept: "application/json, text/event-stream",
				"Content-Type": "application/json",
				...(session ? { "Mcp-Session-Id": session } : {}),
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(10000),
		});
		const text = await response.text();
		let result = null;
		if (text.trim()) {
			try {
				result = JSON.parse(text);
			} catch {
				for (const event of text.split(/\r?\n\r?\n/)) {
					const data = event
						.split(/\r?\n/)
						.filter((s) => s.startsWith("data:"))
						.map((s) => s.slice(5).trimStart())
						.join("\n");
					if (!data.trim()) continue;
					try {
						const message = JSON.parse(data);
						if (message.id === body.id) {
							result = message;
							break;
						}
					} catch {
						/* Ignore empty priming / non-JSON SSE events. */
					}
				}
			}
		}
		return { response, result };
	}
	async function call(name, args = {}) {
		const { response, result } = await request({
			jsonrpc: "2.0",
			id: randomUUID(),
			method: "tools/call",
			params: { name, arguments: args },
		});
		assert.ok(response.ok, `MCP request failed: ${response.status}`);
		assert.equal(result?.error, undefined, JSON.stringify(result?.error));
		assert.notEqual(
			result?.result?.isError,
			true,
			JSON.stringify(result?.result),
		);
		return result.result.structuredContent;
	}
	try {
		// Retire the earlier file-backend compatibility probe's pending proposal;
		// the checkpoint itself uses only the one real granted reviewer below.
		const earlier = await ipc("margin_updates", {
			vaultPath: root,
			reviewId,
			after: 0,
			limit: 1,
		});
		for (const proposal of earlier.data.proposals) {
			const snapshot = await ipc("margin_open", { vaultPath: root, reviewId });
			const dismissed = await ipc("margin_command", {
				vaultPath: root,
				reviewId,
				commandId: randomUUID(),
				request: {
					kind: "dismiss-proposal",
					proposalId: proposal.id,
					expectedStamp: snapshot.data.stamp,
				},
			});
			assert.equal(dismissed.ok, true, JSON.stringify(dismissed));
		}
		await open();
		await evaluate(
			`(() => {const input=document.querySelector('[role="dialog"] input');input.focus();input.setSelectionRange(0,input.value.length);})()`,
		);
		await send("Input.insertText", { text: "Checkpoint AI" });
		await click("margin:ai.enable", dialog);
		await until(
			`(async () => (await window.__TAURI_INTERNALS__.invoke('margin_ai_status')).listening)()`,
			"Scoped MCP did not start",
		);
		const status = await ipc("margin_ai_status", {});
		assert.equal(status.reviewId, reviewId);
		assert.equal(status.label, "Checkpoint AI");
		url = status.url;
		bearer = status.config.mcpServers.margin.headers.Authorization;
		const initialized = await request({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "Not the attribution identity", version: "1" },
			},
		});
		assert.ok(initialized.response.ok);
		session = initialized.response.headers.get("mcp-session-id");
		await request({ jsonrpc: "2.0", method: "notifications/initialized" });
		let read = await call("review_read");
		assert.equal(read.id, reviewId);
		assert.equal(read.you.name, "Checkpoint AI");
		const made = await call("review_comment_add", {
			commandId: randomUUID(),
			expectedHead: read.headId,
			quote: "cautious conclusion",
			body: "Please qualify the strength of this evidence.",
		});
		const cid = made.commandResult.commentId;
		assert.equal(
			made.comments.find((c) => c.id === cid).agent,
			"Checkpoint AI",
		);
		await close();
		await until(
			`document.querySelector('[data-review-comment-id="${cid}"]')?.innerText.includes('Please qualify')`,
			"AI comment did not appear beside the manuscript",
		);
		await evaluate(
			`document.querySelector('[data-review-comment-id="${cid}"] button').click()`,
		);
		const card = `document.querySelector('[data-review-comment-id="${cid}"]')`;
		await click("review:card.reply", card);
		await until(
			`document.querySelector('[data-review-comment-id="${cid}"] textarea')`,
			"Human reply composer did not open",
		);
		await evaluate(`${card}.querySelector('textarea').focus()`);
		await send("Input.insertText", {
			text: "Please propose a cautious rewrite.",
		});
		const replyLabel = await key("review:card.reply");
		await evaluate(
			`[...${card}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(replyLabel)}).click()`,
		);
		await until(
			`!document.querySelector('[data-review-comment-id="${cid}"] textarea')`,
			"Human reply did not save",
		);
		read = await call("review_read");
		const thread = read.comments.find((c) => c.id === cid);
		assert.equal(
			thread.replies.at(-1).body,
			"Please propose a cautious rewrite.",
		);
		assert.equal(thread.replies.at(-1).actor, "author");
		const replyArgs = {
			commandId: randomUUID(),
			commentId: cid,
			action: "reply",
			body: "I will submit a proposal without changing your draft.",
		};
		await call("review_comment_update", replyArgs);
		await call("review_comment_update", replyArgs);
		read = await call("review_read");
		assert.equal(
			read.comments.find((c) => c.id === cid).replies.length,
			2,
			"MCP retries duplicated a reply",
		);
		// Delay the next editor API save, then call its original implementation.
		// Tauri's native bridge is intentionally non-writable; do not replace it.
		await evaluate(
			`(async () => {
				const source=await(await fetch('/src/margin/margin-app.tsx')).text();
				const line=source.split(String.fromCharCode(10)).find(x=>x.includes('/src/lib/review/api.ts'));
				const ref=line?.match(/["']([^"']+)["']/);if(!ref)throw new Error('Cannot resolve the review adapter');
				const {reviewApi}=await import(ref[1]);const original=reviewApi.reviewSaveManuscript;
				let release;const gate=new Promise(r=>{release=r});window.__marginAiHoldSave=true;window.__marginAiSaveWaiting=false;
				reviewApi.reviewSaveManuscript=async(...args)=>{if(window.__marginAiHoldSave){window.__marginAiSaveWaiting=true;await gate;}return original(...args);};
				window.__marginAiReleaseSave=()=>{window.__marginAiHoldSave=false;release();reviewApi.reviewSaveManuscript=original;};
				return true;
			})()`,
		);
		await ensureVisible();
		await typeAtEnd(" Human-only checkpoint draft.");
		await until(
			`window.__marginAiSaveWaiting`,
			"Editor save did not reach the delayed transport",
		);
		const base = await call("review_read");
		assert.ok(
			!base.manuscript.includes("Human-only checkpoint draft."),
			"Unsaved text leaked to AI",
		);
		const staleText = base.manuscript.replace("suggests", "indicates");
		assert.notEqual(staleText, base.manuscript);
		const stale = await call("review_propose", {
			commandId: randomUUID(),
			baseRevision: base.headId,
			markdown: staleText,
		});
		const staleId = stale.commandResult.proposalId;
		assert.equal(
			(await call("review_read")).headId,
			base.headId,
			"AI proposal changed the live head",
		);
		await open();
		await preview(staleId);
		const applyLabel = await key("margin:ai.apply");
		assert.equal(
			await evaluate(
				`[...document.querySelector('[data-margin-proposal-id="${staleId}"]').querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(applyLabel)}).disabled`,
			),
			true,
			"Dirty editor allowed proposal application",
		);
		await evaluate(`window.__marginAiReleaseSave()`);
		await until(
			`(async () => document.querySelector('header [role="status"]')?.textContent === (await import('/src/i18n/index.ts')).default.t('margin:saved'))()`,
			"Delayed author save did not commit",
		);
		const staleLabel = await key("margin:ai.stale");
		await until(
			`document.querySelector('[data-margin-proposal-id="${staleId}"]').innerText.includes(${JSON.stringify(staleLabel)})`,
			"Stale proposal was not marked as stale",
		);
		await click(
			"margin:ai.dismiss",
			`document.querySelector('[data-margin-proposal-id="${staleId}"]')`,
		);
		assert.equal(
			(await call("review_proposal", { proposalId: staleId })).status,
			"dismissed",
		);
		const current = await call("review_read");
		assert.ok(current.manuscript.includes("Human-only checkpoint draft."));
		const updated = current.manuscript.replace("suggests", "indicates");
		assert.notEqual(updated, current.manuscript);
		const proposal = await call("review_propose", {
			commandId: randomUUID(),
			baseRevision: current.headId,
			markdown: updated,
		});
		const pid = proposal.commandResult.proposalId;
		await preview(pid);
		await fs.mkdir("artifacts", { recursive: true });
		const image = await send("Page.captureScreenshot", { format: "png" });
		await fs.writeFile(
			"artifacts/margin-single-ai-review.png",
			Buffer.from(image.data, "base64"),
		);
		await send("Emulation.setDeviceMetricsOverride", {
			width: 720,
			height: 640,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await until(
			`(() => {const rect=document.querySelector('[role="dialog"]').getBoundingClientRect();return rect.top>=0&&rect.bottom<=window.innerHeight&&document.documentElement.scrollWidth<=window.innerWidth;})()`,
			"Narrow AI dialog does not fit the viewport",
		);
		const compact = await send("Page.captureScreenshot", { format: "png" });
		await fs.writeFile(
			"artifacts/margin-single-ai-compact.png",
			Buffer.from(compact.data, "base64"),
		);
		await send("Emulation.clearDeviceMetricsOverride");
		await click(
			"margin:ai.apply",
			`document.querySelector('[data-margin-proposal-id="${pid}"]')`,
		);
		await until(
			`!document.querySelector('[data-margin-proposal-id="${pid}"]')`,
			"Applied proposal stayed pending",
		);
		await close();
		await until(
			`document.querySelector('[data-slate-editor="true"]')?.textContent.includes('indicates')`,
			"Applied proposal did not reach the editor",
		);
		const applied = await call("review_read");
		assert.equal(applied.manuscript, updated);
		assert.equal(
			applied.baselineText,
			current.baselineText,
			"Applying an AI proposal silently accepted the baseline",
		);
		assert.equal(
			(await call("review_proposal", { proposalId: pid })).status,
			"applied",
		);
		await clickReview("toolbar.acceptAll");
		await until(
			`!document.querySelector('[data-review-change]')`,
			"Human revision acceptance did not finish",
		);
		const accepted = await call("review_read");
		assert.equal(accepted.baselineText, accepted.manuscript);
		assert.ok(accepted.manuscript.includes("Human-only checkpoint draft."));
		const news = await call("review_updates", {
			after: current.sequence,
			limit: 200,
		});
		assert.ok(
			news.events.some(
				(e) => e.event.kind === "decision" && e.event.reason === "accept-all",
			),
			"AI cannot observe the human decision",
		);
		await evaluate(`${card}.querySelector('button').click()`);
		await click("review:card.resolve", card);
		await until(
			`(async () => {const v=await window.__TAURI_INTERNALS__.invoke('margin_open',{vaultPath:${JSON.stringify(root)},reviewId:${JSON.stringify(reviewId)}});return v.data.comments.find(c=>c.id===${JSON.stringify(cid)})?.status==='resolved';})()`,
			"Human thread resolution did not commit",
		);
		assert.equal(
			(await call("review_read")).comments.find((c) => c.id === cid).status,
			"resolved",
		);
		await open();
		await click("margin:ai.disconnect", dialog);
		await until(
			`(async () => !(await window.__TAURI_INTERNALS__.invoke('margin_ai_status')).listening)()`,
			"Reviewer disconnect did not complete",
		);
		const before = (await ipc("margin_open", { vaultPath: root, reviewId }))
			.data.sequence;
		let revoked;
		try {
			revoked = await request({
				jsonrpc: "2.0",
				id: 999,
				method: "tools/call",
				params: {
					name: "review_propose",
					arguments: {
						commandId: randomUUID(),
						baseRevision: accepted.headId,
						markdown: `${accepted.manuscript}\nMust not write after disconnect.\n`,
					},
				},
			});
		} catch {
			revoked = null;
		}
		assert.ok(
			!revoked?.response.ok ||
				revoked.result?.error ||
				revoked.result?.result?.isError,
			"Revoked client retained write access",
		);
		assert.equal(
			(await ipc("margin_open", { vaultPath: root, reviewId })).data.sequence,
			before,
		);
		await close();
		// A reconnect retains the reviewer role, but navigating to a new draft
		// must revoke the old document's credential rather than silently retarget it.
		await open();
		await click("margin:ai.enable", dialog);
		await until(
			`(async () => (await window.__TAURI_INTERNALS__.invoke('margin_ai_status')).listening)()`,
			"Reviewer reconnect did not start",
		);
		const reconnected = await ipc("margin_ai_status", {});
		url = reconnected.url;
		bearer = reconnected.config.mcpServers.margin.headers.Authorization;
		session = null;
		const initAgain = await request({
			jsonrpc: "2.0",
			id: 2,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "Different reconnect name", version: "1" },
			},
		});
		session = initAgain.response.headers.get("mcp-session-id");
		await request({ jsonrpc: "2.0", method: "notifications/initialized" });
		const sameRole = await call("review_read");
		assert.equal(sameRole.you.reviewerId, accepted.you.reviewerId);
		await close();
		await click("margin:new");
		await until(
			`(async () => !(await window.__TAURI_INTERNALS__.invoke('margin_ai_status')).listening)()`,
			"Switching manuscripts retained the old grant",
		);
		const newTitle = await key("margin:untitled");
		await until(
			`document.querySelector('header')?.innerText.includes(${JSON.stringify(newTitle)})`,
			"New manuscript did not open",
		);
		const beforeNavigationAttempt = (
			await ipc("margin_open", { vaultPath: root, reviewId })
		).data.sequence;
		let afterNavigation;
		try {
			afterNavigation = await request({
				jsonrpc: "2.0",
				id: 1000,
				method: "tools/call",
				params: {
					name: "review_propose",
					arguments: {
						commandId: randomUUID(),
						baseRevision: sameRole.headId,
						markdown: `${sameRole.manuscript}\nMust not write after navigation.\n`,
					},
				},
			});
		} catch {
			afterNavigation = null;
		}
		assert.ok(
			!afterNavigation?.response.ok ||
				afterNavigation.result?.error ||
				afterNavigation.result?.result?.isError,
			"Old grant survived manuscript navigation",
		);
		assert.equal(
			(await ipc("margin_open", { vaultPath: root, reviewId })).data.sequence,
			beforeNavigationAttempt,
		);
		console.log(
			"Single-AI checkpoint passed: real authenticated MCP, AI signature, shared human/AI thread, idempotent reply, unsaved-draft isolation, stale proposal rejection, human apply/accept, decision readback, reconnect identity and navigation revocation.",
		);
	} finally {
		await send("Emulation.clearDeviceMetricsOverride").catch(() => {});
		await evaluate(
			`(() => {window.__marginAiReleaseSave?.();delete window.__marginAiReleaseSave;delete window.__marginAiHoldSave;delete window.__marginAiSaveWaiting;return true;})()`,
		).catch(() => {});
		await ipc("margin_ai_stop", {}).catch(() => {});
	}
}
