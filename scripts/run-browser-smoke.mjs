import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
	invoke,
	waitForStatus,
	resultText,
	resultEnvelope,
	repositoryRoot as root,
	withBrowserHarness,
} from "./lib/browser-harness.mjs";

async function startFixtureServer() {
	const server = http.createServer((req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		const body = requestUrl.pathname.startsWith("/api/")
			? JSON.stringify({ ok: true, path: req.url })
			: `<!doctype html><html><head><title>Browser Pilot Smoke</title></head><body><main><h1 id="smoke-marker">Browser Pilot Smoke</h1><button id="smoke-action" type="button" onclick="this.dataset.clicked='yes'">Run smoke</button><canvas id="visual-surface" width="240" height="120" style="display:block;border:1px solid #000"></canvas><input id="visual-input" aria-label="Visual input"><form id="smoke-form" onsubmit="return false"><label>Full name <input id="full-name" name="fullName" value="Old Name" placeholder="Your name"></label><label><input id="agree" type="checkbox"> Agree to terms</label><label>Country <select id="country"><option value="us">United States</option><option value="cn">China</option><option value="jp">Japan</option></select></label></form></main><script>
					const canvas=document.querySelector('#visual-surface'),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#1266cc';ctx.fillRect(20,20,80,60);
					canvas.addEventListener('click',event=>{canvas.dataset.clickX=String(Math.round(event.offsetX));canvas.dataset.clickY=String(Math.round(event.offsetY));canvas.dataset.clickCount=String(Number(canvas.dataset.clickCount||0)+1);ctx.fillStyle='#d22';ctx.fillRect(event.offsetX,event.offsetY,8,8)});
					canvas.addEventListener('mousedown',event=>{canvas.dataset.dragStart=Math.round(event.offsetX)+','+Math.round(event.offsetY)});canvas.addEventListener('mouseup',event=>{canvas.dataset.dragEnd=Math.round(event.offsetX)+','+Math.round(event.offsetY)});
					canvas.addEventListener('wheel',event=>{event.preventDefault();canvas.dataset.wheelY=String(Math.round(event.deltaY));ctx.fillStyle='#2a2';ctx.fillRect(120,20,20,20)},{passive:false});fetch('/api/boot');
				</script></body></html>`;
		res.writeHead(200, {
			"content-type": requestUrl.pathname.startsWith("/api/") ? "application/json" : "text/html; charset=utf-8",
			"content-length": Buffer.byteLength(body),
		});
		res.end(body);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
	return {
		url: "http://127.0.0.1:" + address.port + "/",
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

function requireEffect(value, label, options = {}) {
	const effect = value?.effect;
	if (effect?.observed !== true)
		throw new Error(`${label} did not return observed page-effect feedback: ${JSON.stringify(value)}`);
	if (effect.changed !== (options.changed ?? true))
		throw new Error(`${label} returned unexpected changed state: ${JSON.stringify(effect)}`);
	if (options.settled !== false && effect.settled !== true)
		throw new Error(`${label} did not settle: ${JSON.stringify(effect)}`);
	if (options.newTabs !== undefined && effect.newTabs !== options.newTabs)
		throw new Error(`${label} returned unexpected new-tab count: ${JSON.stringify(effect)}`);
	return effect;
}

function normalizedVisualPoint(rect, x, y) {
	const width = Number(rect?.viewportWidth);
	const height = Number(rect?.viewportHeight);
	if (!(width > 0 && height > 0)) throw new Error(`visual geometry has no viewport: ${JSON.stringify(rect)}`);
	return { x: (Number(rect.x) + x) / width, y: (Number(rect.y) + y) / height };
}

async function requirePngResource(resourceUri, label) {
	const prefix = "browser-pilot://artifact/";
	if (typeof resourceUri !== "string" || !resourceUri.startsWith(prefix))
		throw new Error(`${label} did not return an artifact resource: ${String(resourceUri)}`);
	const relative = resourceUri.slice(prefix.length).split("/").map(decodeURIComponent);
	const data = await readFile(path.join(root, ".browser-pilot", "artifacts", ...relative));
	if (data.length < 8 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
		throw new Error(`${label} resource is not a PNG: ${resourceUri}`);
}

await withBrowserHarness(startFixtureServer, async ({ daemon, browser, fixture }) => {
	const tab = browser.status.tabs.find((item) => String(item?.url || "").startsWith(fixture.url));
	const tabId = Number(tab?.tabId ?? tab?.id);
	if (!Number.isInteger(tabId) || tabId <= 0) throw new Error(`fixture tab was not routable: ${JSON.stringify(tab)}`);
	const targetRef =
		typeof tab?.targetRef === "string" ? tab.targetRef : typeof tab?.tabHandle === "string" ? tab.tabHandle : "";
	if (!targetRef) throw new Error(`fixture tab had no stable targetRef: ${JSON.stringify(tab)}`);
	const tabs = await invoke(daemon, "browser_tabs", { action: "list" });
	if (!resultText(tabs).includes("Browser Pilot Smoke"))
		throw new Error(`browser_tabs did not expose the fixture tab: ${resultText(tabs)}`);
	const executed = await invoke(daemon, "browser_execute", {
		targetRef,
		readOnly: true,
		script: "(async()=>{const api=await(await fetch('/api/execute')).json();return{title:document.title,marker:document.querySelector('#smoke-marker')?.textContent,api:api.ok}})()",
	});
	const executedResult = resultEnvelope(executed, "browser_execute");
	if (!resultText(executed).includes("Browser Pilot Smoke"))
		throw new Error(`browser_execute did not return fixture evidence: ${resultText(executed)}`);
	if (executedResult.result?.title !== "Browser Pilot Smoke")
		throw new Error(`browser_execute did not return raw script data: ${JSON.stringify(executedResult)}`);
	const cdp = resultEnvelope(
		await invoke(daemon, "browser_command", {
			targetRef,
			command: {
				cmd: "cdp",
				method: "Runtime.evaluate",
				params: { expression: "document.title", returnByValue: true },
			},
		}),
		"browser_command cdp",
	);
	if (cdp.result?.result?.value !== "Browser Pilot Smoke")
		throw new Error(`browser_command cdp did not return raw browser evidence: ${JSON.stringify(cdp)}`);

	const created = resultEnvelope(
		await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}secondary`, active: true }),
		"browser_tabs create",
	);
	const createdTargetRef = created.tabs?.[0]?.targetRef;
	if (!createdTargetRef) throw new Error(`created tab was not routable: ${JSON.stringify(created)}`);
	resultEnvelope(
		await invoke(daemon, "browser_tabs", { action: "close", targetRef: createdTargetRef }),
		"browser_tabs close",
	);
	const background = resultEnvelope(
		await invoke(daemon, "browser_tabs", { action: "create", url: `${fixture.url}background`, active: false }),
		"browser_tabs create background",
	);
	const backgroundTargetRef = background.tabs?.[0]?.targetRef;
	if (!backgroundTargetRef) throw new Error(`background tab was not routable: ${JSON.stringify(background)}`);
	const backgroundWrite = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef: backgroundTargetRef,
			script: "document.documentElement.dataset.background='yes'; true",
		}),
		"background browser_execute",
	);
	requireEffect(backgroundWrite, "background browser_execute");
	resultEnvelope(
		await invoke(daemon, "browser_tabs", { action: "close", targetRef: backgroundTargetRef }),
		"browser_tabs close background",
	);

	const networkStarted = resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.start", clear: true } }),
		"browser_command network.start",
	);
	requireEffect(networkStarted, "browser_command network.start", { changed: false });
	await invoke(daemon, "browser_execute", {
		targetRef,
		readOnly: true,
		script: "fetch('/api/smoke').then(r=>r.text())",
	});
	const network = await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.list", limit: 20 } });
	if (!/api\/smoke/.test(resultText(network)))
		throw new Error(`browser_command network.list did not return capture evidence: ${resultText(network)}`);
	const networkStopped = resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.stop" } }),
		"browser_command network.stop",
	);
	requireEffect(networkStopped, "browser_command network.stop", { changed: false });
	resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.install", targets: ["console"] } }),
		"browser_command hook.install",
	);
	const hookReused = resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.install", targets: ["console"] } }),
		"browser_command hook.install reuse",
	);
	if (hookReused.result?.idempotent !== true && hookReused.result?.reused !== true)
		throw new Error(`hook.install did not reuse its runtime-owned session: ${JSON.stringify(hookReused)}`);
	resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "hook.uninstall" } }),
		"browser_command hook.uninstall",
	);

	const visualGeometry = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "(()=>{const box=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}};return{canvas:box(document.querySelector('#visual-surface')),input:box(document.querySelector('#visual-input'))}})()",
		}),
		"visual geometry",
	).result;
	const observeVisual = async (label) => {
		const value = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, visual: "always" }), label);
		const visual = value.visual;
		if (typeof visual?.ref !== "string" || visual.actionableGrounding !== true)
			throw new Error(`${label} did not return actionable visual evidence: ${JSON.stringify(visual)}`);
		await requirePngResource(visual.resourceUri, label);
		return visual;
	};
	const visualCommand = (visual, action, point, extra = {}) =>
		invoke(daemon, "browser_command", {
			command: {
				cmd: "input.ref",
				action,
				ref: visual.ref,
				visual: { point, ...(extra.to ? { to: extra.to } : {}) },
				...extra.command,
			},
		});

	const clickVisual = await observeVisual("visual click observe");
	const clickPoint = normalizedVisualPoint(visualGeometry.canvas, 31, 19);
	const visualClick = resultEnvelope(await visualCommand(clickVisual, "click", clickPoint), "visual click");
	const visualClickEffect = requireEffect(visualClick, "visual click");
	if (visualClickEffect.visual?.observed !== true || visualClickEffect.visual.changed !== true)
		throw new Error(`visual click did not return changed pixel evidence: ${JSON.stringify(visualClickEffect)}`);
	await requirePngResource(visualClickEffect.visual.resourceUri, "visual click effect");
	const clickCoordinates = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "(()=>{const c=document.querySelector('#visual-surface');return{x:Number(c.dataset.clickX),y:Number(c.dataset.clickY),count:Number(c.dataset.clickCount)}})()",
		}),
		"visual click coordinates",
	).result;
	if (Math.abs(clickCoordinates.x - 31) > 1 || Math.abs(clickCoordinates.y - 19) > 1 || clickCoordinates.count !== 1)
		throw new Error(`visual click was recentered or missed: ${JSON.stringify(clickCoordinates)}`);

	const dragVisual = await observeVisual("visual drag observe");
	const dragFrom = normalizedVisualPoint(visualGeometry.canvas, 24, 30);
	const dragTo = normalizedVisualPoint(visualGeometry.canvas, 180, 72);
	resultEnvelope(await visualCommand(dragVisual, "drag", dragFrom, { to: dragTo }), "visual drag");
	const dragCoordinates = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "(()=>{const c=document.querySelector('#visual-surface');return{from:c.dataset.dragStart,to:c.dataset.dragEnd}})()",
		}),
		"visual drag coordinates",
	).result;
	const [dragFromX, dragFromY] = String(dragCoordinates.from).split(",").map(Number);
	const [dragToX, dragToY] = String(dragCoordinates.to).split(",").map(Number);
	if (
		Math.abs(dragFromX - 24) > 1 ||
		Math.abs(dragFromY - 30) > 1 ||
		Math.abs(dragToX - 180) > 1 ||
		Math.abs(dragToY - 72) > 1
	)
		throw new Error(`visual drag coordinates changed: ${JSON.stringify(dragCoordinates)}`);

	const wheelVisual = await observeVisual("visual wheel observe");
	const wheelPoint = normalizedVisualPoint(visualGeometry.canvas, 80, 60);
	resultEnvelope(await visualCommand(wheelVisual, "wheel", wheelPoint, { command: { deltaY: 47 } }), "visual wheel");
	const wheelY = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "Number(document.querySelector('#visual-surface').dataset.wheelY)",
		}),
		"visual wheel delta",
	).result;
	if (wheelY !== 47) throw new Error(`visual wheel delta changed: ${JSON.stringify(wheelY)}`);

	const typeVisual = await observeVisual("visual type observe");
	const typePoint = normalizedVisualPoint(
		visualGeometry.input,
		visualGeometry.input.width / 2,
		visualGeometry.input.height / 2,
	);
	const visualType = resultEnvelope(
		await visualCommand(typeVisual, "type", typePoint, { command: { text: "pixel input" } }),
		"visual type",
	);
	if (visualType.effect?.visual?.observed !== true)
		throw new Error(`visual type did not return pixel evidence: ${JSON.stringify(visualType)}`);
	const typedValue = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "document.querySelector('#visual-input').value",
		}),
		"visual type value",
	).result;
	if (typedValue !== "pixel input") throw new Error(`visual type missed its target: ${JSON.stringify(typedValue)}`);

	resultEnvelope(
		await invoke(daemon, "browser_execute", { targetRef, script: "document.activeElement?.blur();true" }),
		"blur visual input",
	);
	const staleVisual = await observeVisual("visual stale observe");
	const stalePoint = normalizedVisualPoint(visualGeometry.canvas, 60, 40);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const c=document.querySelector('#visual-surface');const x=c.getContext('2d');x.fillStyle='#111';x.fillRect(0,0,12,12);return true})()",
		}),
		"mutate visual pixels",
	);
	const staleVisualInput = resultEnvelope(
		await visualCommand(staleVisual, "click", stalePoint),
		"stale visual click",
	);
	if (staleVisualInput.code !== "REF_STALE")
		throw new Error(`visual input did not reject changed pixels: ${JSON.stringify(staleVisualInput)}`);

	const observed = resultEnvelope(
		await invoke(daemon, "browser_observe", { targetRef, mode: "full" }),
		"browser_observe",
	);
	if (typeof observed.content?.text !== "string") {
		throw new Error(`browser_observe did not return a PageObservation view: ${JSON.stringify(observed)}`);
	}
	if (observed.visual?.actionableGrounding !== true)
		throw new Error(`browser_observe auto mode did not attach visual evidence: ${JSON.stringify(observed.visual)}`);
	if (!observed.content.text.includes("Browser Pilot Smoke"))
		throw new Error(`browser_observe did not return page content: ${JSON.stringify(observed.content)}`);
	const actionRef = Array.isArray(observed.actionSpace?.items)
		? observed.actionSpace.items.find((entity) => entity?.name === "Run smoke")?.ref
		: undefined;
	if (typeof actionRef !== "string")
		throw new Error(`browser_observe did not mint the smoke action ref: ${JSON.stringify(observed.actionSpace)}`);
	const bound = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			refs: { action: actionRef },
			readOnly: true,
			script: "({id:browserPilot.refs.action?.id,tag:browserPilot.refs.action?.tagName})",
		}),
		"browser_execute refs",
	);
	if (bound.result?.id !== "smoke-action" || bound.result?.tag !== "BUTTON")
		throw new Error(`browser_execute did not bind the observed ref: ${JSON.stringify(bound)}`);

	// Trusted form input through observed refs: type (replace), check, select, then confirm through observe.
	const formItems = observed.actionSpace.items;
	const itemByName = (name) => formItems.find((entity) => entity?.name === name);
	const nameField = itemByName("Full name");
	const agreeBox = itemByName("Agree to terms");
	const countrySelect = itemByName("Country");
	if (!nameField?.ref || !agreeBox?.ref || !countrySelect?.ref)
		throw new Error(
			`browser_observe did not expose the form controls: ${JSON.stringify(formItems.map((item) => item?.name))}`,
		);
	if (nameField.value !== "Old Name" || nameField.placeholder !== "Your name")
		throw new Error(`browser_observe did not project the field value/placeholder: ${JSON.stringify(nameField)}`);
	const typed = resultEnvelope(
		await invoke(daemon, "browser_command", {
			command: { cmd: "input.ref", action: "type", ref: nameField.ref, text: "Ada Lovelace", clear: true },
			expect: "document.querySelector('#full-name').value === 'Ada Lovelace'",
		}),
		"input.ref type",
	);
	if (typed.verification?.status !== "verified")
		throw new Error(`input.ref type was not verified: ${JSON.stringify(typed)}`);
	const checked = resultEnvelope(
		await invoke(daemon, "browser_command", {
			command: { cmd: "input.ref", action: "check", ref: agreeBox.ref },
			expect: { ref: agreeBox.ref, state: { checked: true } },
		}),
		"input.ref check",
	);
	if (checked.result?.input?.check?.applied !== true || checked.verification?.status !== "verified")
		throw new Error(`input.ref check did not toggle and verify: ${JSON.stringify(checked)}`);
	const selected = resultEnvelope(
		await invoke(daemon, "browser_command", {
			command: { cmd: "input.ref", action: "select", ref: countrySelect.ref, label: "China" },
			expect: "document.querySelector('#country').value === 'cn'",
		}),
		"input.ref select",
	);
	if (selected.verification?.status !== "verified")
		throw new Error(`input.ref select was not verified: ${JSON.stringify(selected)}`);
	const formState = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "({name:document.querySelector('#full-name').value,agree:document.querySelector('#agree').checked,country:document.querySelector('#country').value})",
		}),
		"form state",
	).result;
	if (formState.name !== "Ada Lovelace" || formState.agree !== true || formState.country !== "cn")
		throw new Error(`trusted form input did not land: ${JSON.stringify(formState)}`);
	const reobserved = resultEnvelope(
		await invoke(daemon, "browser_observe", { targetRef, mode: "full", visual: "never" }),
		"browser_observe after form input",
	);
	const reobservedName = reobserved.actionSpace?.items?.find((entity) => entity?.name === "Full name");
	if (reobservedName?.value !== "Ada Lovelace")
		throw new Error(`browser_observe did not reflect the typed value: ${JSON.stringify(reobservedName)}`);
	const unmet = resultEnvelope(
		await invoke(daemon, "browser_command", {
			command: { cmd: "input.ref", action: "check", ref: agreeBox.ref, checked: true },
			expect: { ref: agreeBox.ref, state: { checked: false } },
		}),
		"input.ref unmet expectation",
	);
	if (
		unmet.verification?.status !== "unmet" ||
		unmet.verification.elapsedMs < 4_800 ||
		unmet.verification.elapsedMs > 7_000
	)
		throw new Error(
			`unmet expectation did not respect its verification budget: ${JSON.stringify(unmet.verification)}`,
		);

	for (const delayMs of [600, 1_000]) {
		const delayed = resultEnvelope(
			await invoke(daemon, "browser_execute", {
				targetRef,
				script: `document.body.dataset.delayedReady = 'no'; setTimeout(() => { document.body.dataset.delayedReady = 'yes'; }, ${delayMs}); true`,
				expect: "document.body.dataset.delayedReady === 'yes'",
			}),
			"delayed postcondition",
		);
		if (delayed.verification?.status !== "verified") throw new Error(`Delayed ${delayMs}ms postcondition failed`);
	}

	const waited = resultEnvelope(
		await invoke(daemon, "browser_command", {
			targetRef,
			command: { cmd: "wait.selector", selector: "#smoke-marker", state: "visible" },
		}),
		"browser_command wait.selector",
	);
	if (waited.code) throw new Error(`wait.selector failed: ${JSON.stringify(waited)}`);
	const loaded = resultEnvelope(
		await invoke(daemon, "browser_command", { targetRef, command: { cmd: "wait.loadState", state: "complete" } }),
		"browser_command wait.loadState",
	);
	if (loaded.code) throw new Error(`wait.loadState failed: ${JSON.stringify(loaded)}`);

	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const old=document.querySelector('#smoke-action');const next=old.cloneNode(true);next.id='smoke-action-rerendered';old.replaceWith(next);return true})()",
		}),
		"rerender ref target",
	);
	const rebound = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			refs: { action: actionRef },
			readOnly: true,
			script: "({id:browserPilot.refs.action?.id,tag:browserPilot.refs.action?.tagName})",
		}),
		"browser_execute rebound ref",
	);
	if (rebound.result?.id !== "smoke-action-rerendered" || rebound.result?.tag !== "BUTTON")
		throw new Error(`browser_execute did not rebind the rerendered ref: ${JSON.stringify(rebound)}`);
	const input = resultEnvelope(
		await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }),
		"browser_command input.ref",
	);
	requireEffect(input, "browser_command input.ref");
	if (input.result?.input?.resolution !== "liveLocator")
		throw new Error(`input.ref did not fall back from the stale backend node: ${JSON.stringify(input)}`);
	const clicked = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			refs: { action: actionRef },
			readOnly: true,
			script: "browserPilot.refs.action?.dataset.clicked",
		}),
		"browser_execute ref verification",
	);
	if (clicked.result !== "yes")
		throw new Error(`input.ref did not dispatch the physical click: ${JSON.stringify(clicked)}`);
	const continuedObservation = resultEnvelope(
		await invoke(daemon, "browser_observe", { targetRef, mode: "full" }),
		"continued browser_observe",
	);
	const continuedRef = Array.isArray(continuedObservation.actionSpace?.items)
		? continuedObservation.actionSpace.items.find((entity) => entity?.name === "Run smoke")?.ref
		: undefined;
	if (continuedRef !== actionRef)
		throw new Error(
			`browser_observe did not preserve semantic identity across rerender: ${JSON.stringify({ actionRef, continuedRef })}`,
		);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const el=document.querySelector('#smoke-action-rerendered');el.dataset.clicked='';el.textContent='Changed action';return true})()",
		}),
		"change ref semantics",
	);
	const semanticMismatch = resultEnvelope(
		await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }),
		"semantic mismatch input.ref",
	);
	if (semanticMismatch.code !== "REF_STALE")
		throw new Error(`input.ref did not reject changed semantics: ${JSON.stringify(semanticMismatch)}`);
	// Reads stay lenient: a script may still resolve the renamed control and inspect it.
	const renamedRead = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			refs: { action: actionRef },
			readOnly: true,
			script: "({text:browserPilot.refs.action?.textContent})",
		}),
		"renamed control read",
	);
	if (renamedRead.result?.text !== "Changed action")
		throw new Error(`browser_execute could not read the renamed control: ${JSON.stringify(renamedRead)}`);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const el=document.querySelector('#smoke-action-rerendered');el.textContent='Run smoke';const rect=el.getBoundingClientRect();const cover=document.createElement('div');cover.id='smoke-cover';Object.assign(cover.style,{position:'fixed',left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`,zIndex:'2147483647'});document.body.append(cover);return true})()",
		}),
		"cover ref target",
	);
	const occluded = resultEnvelope(
		await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }),
		"occluded input.ref",
	);
	if (occluded.code !== "TARGET_OCCLUDED")
		throw new Error(`input.ref did not reject an occluded target: ${JSON.stringify(occluded)}`);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "document.querySelector('#smoke-cover')?.remove()",
		}),
		"uncover ref target",
	);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const old=document.querySelector('#smoke-action-rerendered');const next=document.createElement('button');next.id='danger-action';next.textContent='Danger';next.onclick=()=>{next.dataset.clicked='yes'};old.replaceWith(next);return true})()",
		}),
		"replace ref target",
	);
	const staleInput = resultEnvelope(
		await invoke(daemon, "browser_command", { command: { cmd: "input.ref", action: "click", ref: actionRef } }),
		"stale input.ref",
	);
	if (staleInput.code !== "BACKEND_NODE_STALE")
		throw new Error(`stale input.ref did not fail closed: ${JSON.stringify(staleInput)}`);
	const untouched = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			readOnly: true,
			script: "document.querySelector('#danger-action')?.dataset.clicked",
		}),
		"stale ref verification",
	);
	if (untouched.result !== undefined && untouched.result !== "[undefined]")
		throw new Error(`stale input.ref clicked the replacement element: ${JSON.stringify(untouched)}`);
	resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{const root=document.createElement('div'),fragment=document.createDocumentFragment();root.id='large-dom';for(let i=0;i<20000;i++){const span=document.createElement('span');span.textContent=`node ${i}`;fragment.append(span)}root.append(fragment);document.body.append(root);return true})()",
		}),
		"large DOM fixture",
	);
	const boundedObservation = resultEnvelope(
		await invoke(daemon, "browser_observe", { targetRef, mode: "full", visual: "never" }),
		"bounded large DOM observe",
		20_000,
	);
	if (
		boundedObservation.content?.complete !== false ||
		boundedObservation.actionSpace?.coverage?.captureComplete !== true
	)
		throw new Error(
			`large DOM observation did not preserve its bounded content and complete action coverage: ${JSON.stringify(boundedObservation)}`,
		);
	const burst = resultEnvelope(
		await invoke(daemon, "browser_execute", {
			targetRef,
			script: "(()=>{let n=0;const timer=setInterval(()=>{document.documentElement.dataset.burst=String(++n);if(n===4)clearInterval(timer)},15);return true})()",
		}),
		"burst browser_execute",
	);
	requireEffect(burst, "burst browser_execute");
	const popupUrl = `${fixture.url}popup`;
	const opened = resultEnvelope(
		await invoke(daemon, "browser_execute", { targetRef, script: `GM_openInTab('${popupUrl}')` }),
		"new-tab browser_execute",
	);
	requireEffect(opened, "new-tab browser_execute", { newTabs: 1 });
	const popupStatus = await waitForStatus(
		daemon,
		(value) => Array.isArray(value.tabs) && value.tabs.some((item) => String(item?.url || "").startsWith(popupUrl)),
		"browser_execute new tab routing",
	);
	const popup = popupStatus.tabs.find((item) => String(item?.url || "").startsWith(popupUrl));
	if (!popup?.targetRef)
		throw new Error(`new browser_execute tab was not routable: ${JSON.stringify(popupStatus.tabs)}`);
	resultEnvelope(
		await invoke(daemon, "browser_tabs", { action: "close", targetRef: popup.targetRef }),
		"browser_tabs close popup",
	);
	const navigated = resultEnvelope(
		await invoke(daemon, "browser_execute", { targetRef, script: `location.href='${fixture.url}navigated'` }),
		"navigation browser_execute",
	);
	const navigationEffect = requireEffect(navigated, "navigation browser_execute", { settled: false });
	if (!navigationEffect.page?.navigation)
		throw new Error(`navigation browser_execute did not report navigation: ${JSON.stringify(navigationEffect)}`);
	const toolNavigated = resultEnvelope(
		await invoke(daemon, "browser_tabs", {
			action: "navigate",
			targetRef,
			url: `${fixture.url}tool-navigated`,
			waitUntil: "complete",
		}),
		"browser_tabs navigate",
	);
	if (!String(toolNavigated.tabs?.[0]?.url || "").startsWith(`${fixture.url}tool-navigated`))
		throw new Error(`browser_tabs navigate did not land on the target: ${JSON.stringify(toolNavigated)}`);
	if (toolNavigated.effect?.page?.navigation?.to !== `${fixture.url}tool-navigated`)
		throw new Error(`browser_tabs navigate did not report its navigation: ${JSON.stringify(toolNavigated.effect)}`);

	console.log(
		JSON.stringify(
			{
				ok: true,
				browser: browser.executable,
				bridgePort: daemon.bridgePort,
				tabId,
				checks: [
					"extension-handshake",
					"tabs",
					"execute",
					"raw-cdp-auto-lifecycle",
					"tab-create-close",
					"background-cdp-effect",
					"browser-command-network-effect",
					"hook-auto-session",
					"visual-observe-resource",
					"visual-click-exact",
					"visual-drag",
					"visual-wheel",
					"visual-type",
					"visual-stale-rejected",
					"visual-auto",
					"canonical-observe",
					"direct-observe-content",
					"ref-execute",
					"form-value-projection",
					"input-ref-type-check-select",
					"unmet-expectation-bounded-budget",
					"delayed-postcondition-success",
					"wait-selector-loadstate",
					"ref-rerender-rebound",
					"ref-input-effect",
					"ref-observation-continuity",
					"ref-semantic-mismatch-rejected",
					"ref-occlusion-rejected",
					"stale-ref-rejected",
					"bounded-large-dom-observe",
					"burst-effect",
					"new-tab-effect",
					"navigation-effect",
					"tabs-navigate",
				],
			},
			null,
			2,
		),
	);
});
