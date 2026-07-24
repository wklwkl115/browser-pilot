// Generates README GIFs from real Browser Pilot commands. Requires ffmpeg on PATH.
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(root, "bridge", "browser_pilot_bridge");
const outputDir = path.join(root, "docs", "assets");
const launchTimeoutMs = 20_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageShell(title, eyebrow, content, script = "") {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html { height: 100%; overflow: hidden; }
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0b1220; background: #e8edf4; }
  body { margin: 0; min-width: 1180px; height: 100vh; overflow: hidden; background: #e8edf4; }
  button, input, select { font: inherit; }
  .topbar { position: fixed; inset: 0 0 auto; z-index: 10; height: 68px; display: flex; align-items: center; justify-content: space-between; padding: 0 30px; color: #f8fafc; background: #0b1220; border-bottom: 3px solid #22d3ee; }
  .brand { display: flex; align-items: center; gap: 12px; font-weight: 760; font-size: 20px; }
  .brand-mark { width: 28px; height: 28px; display: grid; place-items: center; border: 2px solid #22d3ee; border-radius: 6px; color: #22d3ee; font: 800 13px ui-monospace, SFMono-Regular, Consolas, monospace; }
  .connection { display: flex; align-items: center; gap: 9px; color: #cbd5e1; font-size: 14px; }
  .connection::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 4px rgb(34 197 94 / 16%); }
  .layout { display: grid; grid-template-columns: 196px 1fr; height: 100vh; padding-top: 68px; }
  .nav { padding: 24px 18px; color: #94a3b8; background: #111c31; }
  .nav-label { margin: 0 10px 14px; color: #64748b; font: 700 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; }
  .nav-item { display: flex; align-items: center; gap: 10px; padding: 11px 12px; margin-bottom: 5px; border-radius: 6px; font-size: 14px; }
  .nav-item.active { color: #f8fafc; background: #1e2b45; }
  .nav-icon { width: 8px; height: 8px; border-radius: 2px; background: #64748b; }
  .nav-item.active .nav-icon { background: #22d3ee; }
  main { padding: 28px 32px 34px; overflow: hidden; }
  .eyebrow { margin: 0 0 7px; color: #2563eb; font: 750 12px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; }
  h1 { margin: 0; font-size: 30px; line-height: 1.15; letter-spacing: 0; }
  .lede { margin: 8px 0 22px; color: #64748b; font-size: 15px; }
  .workspace { display: grid; grid-template-columns: minmax(0, 1fr) 310px; min-height: 520px; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; box-shadow: 0 14px 36px rgb(15 23 42 / 9%); }
  .work { padding: 26px 28px; }
  .trace { padding: 22px; color: #e2e8f0; background: #111c31; border-left: 1px solid #253451; }
  .trace-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .trace h2 { margin: 0; font-size: 15px; }
  .trace-badge { padding: 4px 7px; color: #22d3ee; border: 1px solid #256078; border-radius: 4px; font: 700 10px ui-monospace, SFMono-Regular, Consolas, monospace; }
  #trace-list { display: grid; gap: 10px; }
  .trace-row { padding: 11px 12px; border: 1px solid #2b3a57; border-radius: 6px; background: #17233a; }
  .trace-tool { color: #22d3ee; font: 700 11px ui-monospace, SFMono-Regular, Consolas, monospace; }
  .trace-detail { margin-top: 5px; color: #cbd5e1; font-size: 12px; line-height: 1.35; }
  .trace-row.live { border-color: #f59e0b; }
  .trace-row.live .trace-tool { color: #f59e0b; }
  .section-title { margin: 0 0 18px; font-size: 18px; }
  .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .field.full { grid-column: 1 / -1; }
  label { display: grid; gap: 7px; color: #475569; font-size: 12px; font-weight: 700; }
  input, select { width: 100%; height: 44px; padding: 0 12px; color: #0f172a; background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 5px; outline: none; }
  input:focus, select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgb(37 99 235 / 12%); }
  .primary { height: 44px; padding: 0 18px; color: #fff; background: #2563eb; border: 0; border-radius: 5px; font-weight: 750; cursor: pointer; }
  .primary:active { transform: translateY(1px); }
  .form-actions { display: flex; justify-content: flex-end; margin-top: 22px; }
  .success { display: none; align-items: center; gap: 12px; margin-top: 20px; padding: 15px 16px; color: #166534; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; font-weight: 700; }
  .success[data-visible="true"] { display: flex; }
  .check { width: 24px; height: 24px; display: grid; place-items: center; color: #fff; background: #22c55e; border-radius: 50%; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
  .search { width: 270px; }
  .count { color: #64748b; font-size: 13px; }
  .table-head, .invoice-row { display: grid; grid-template-columns: 110px 1.3fr 1fr 105px; align-items: center; gap: 12px; width: 100%; }
  .table-head { padding: 9px 14px; color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; font: 700 11px ui-monospace, SFMono-Regular, Consolas, monospace; text-transform: uppercase; }
  .invoice-row { min-height: 56px; padding: 10px 14px; color: #0f172a; background: #fff; border: 0; border-bottom: 1px solid #e2e8f0; text-align: left; cursor: pointer; }
  .invoice-row[hidden] { display: none; }
  .invoice-row:hover, .invoice-row:focus { background: #eff6ff; outline: none; }
  .status { width: fit-content; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 750; }
  .status.overdue { color: #9f1239; background: #ffe4e6; }
  .status.paid { color: #166534; background: #dcfce7; }
  .drawer { display: none; margin-top: 16px; padding: 17px; background: #f8fafc; border: 1px solid #93c5fd; border-left: 4px solid #2563eb; border-radius: 5px; }
  .drawer[data-visible="true"] { display: block; }
  .drawer strong { display: block; margin-bottom: 6px; }
  .metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px; }
  .metric { padding: 17px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; }
  .metric-label { color: #64748b; font-size: 12px; }
  .metric-value { margin-top: 5px; font-size: 24px; font-weight: 800; }
  .sync-panel { display: flex; align-items: center; justify-content: space-between; padding: 20px; border: 1px solid #cbd5e1; border-radius: 6px; }
  .sync-copy strong { display: block; margin-bottom: 5px; }
  .sync-copy span { color: #64748b; font-size: 13px; }
  .request { display: none; grid-template-columns: 90px 1fr 55px; gap: 12px; align-items: center; margin-top: 18px; padding: 14px; background: #0b1220; border-radius: 6px; color: #e2e8f0; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
  .request[data-visible="true"] { display: grid; }
  .method { color: #22d3ee; font-weight: 800; }
  .http-ok { color: #4ade80; font-weight: 800; }
  .spin { animation: pulse .6s ease-in-out infinite alternate; }
  @keyframes pulse { from { opacity: .45; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
<header class="topbar"><div class="brand"><span class="brand-mark">BP</span>Browser Pilot Operations</div><div class="connection">Extension connected</div></header>
<div class="layout">
  <nav class="nav"><p class="nav-label">Workspace</p><div class="nav-item active"><span class="nav-icon"></span>Agent run</div><div class="nav-item"><span class="nav-icon"></span>Evidence</div><div class="nav-item"><span class="nav-icon"></span>Browser tabs</div><div class="nav-item"><span class="nav-icon"></span>Run history</div></nav>
  <main><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="lede">Real Chrome session driven through Browser Pilot's public MCP tools.</p>
    <section class="workspace"><div class="work">${content}</div><aside class="trace"><div class="trace-head"><h2>Agent trace</h2><span class="trace-badge">LIVE MCP</span></div><div id="trace-list"><div class="trace-row"><div class="trace-tool">session.ready</div><div class="trace-detail">Browser and extension handshake complete</div></div></div></aside></section>
  </main>
</div>
<script>
window.demoTrace=(tool,detail,state='done')=>{const list=document.querySelector('#trace-list');if(list.children.length>=5)list.firstElementChild.remove();const row=document.createElement('div');row.className='trace-row '+(state==='live'?'live':'');row.innerHTML='<div class="trace-tool"></div><div class="trace-detail"></div>';row.children[0].textContent=tool;row.children[1].textContent=detail;list.append(row)};
${script}
</script>
</body></html>`;
}

function fixturePage(pathname) {
	if (pathname === "/table") {
		const rows = [
			["INV-2048", "Northwind Labs", "$8,420", "Overdue"],
			["INV-2047", "Aperture Works", "$3,180", "Paid"],
			["INV-2046", "Summit Retail", "$6,900", "Overdue"],
			["INV-2045", "Bluebird Health", "$2,760", "Paid"],
		].map(([id, account, amount, status]) => `<button class="invoice-row" type="button" data-status="${status.toLowerCase()}" aria-label="Open invoice ${id}"><strong>${id}</strong><span>${account}</span><span>${amount}</span><span class="status ${status.toLowerCase()}">${status}</span></button>`).join("");
		return pageShell("Resolve overdue invoices", "Structured page observation", `<h2 class="section-title">Invoice queue</h2><div class="toolbar"><input class="search" id="invoice-filter" aria-label="Filter invoices" placeholder="Filter by status or account"><span class="count" id="invoice-count">4 records</span></div><div class="table-head"><span>Invoice</span><span>Account</span><span>Amount</span><span>Status</span></div><div id="invoice-rows">${rows}</div><div class="drawer" id="invoice-drawer" data-visible="false"><strong id="drawer-title">Invoice</strong><span>Owner: Finance Operations · Next action: Contact account owner</span></div>`, `
const filter=document.querySelector('#invoice-filter'),rows=[...document.querySelectorAll('.invoice-row')],count=document.querySelector('#invoice-count'),drawer=document.querySelector('#invoice-drawer');
filter.addEventListener('input',()=>{const q=filter.value.toLowerCase();let shown=0;for(const row of rows){const visible=row.textContent.toLowerCase().includes(q);row.hidden=!visible;if(visible)shown++}count.textContent=shown+' records';drawer.dataset.visible='false'});
for(const row of rows)row.addEventListener('click',()=>{document.querySelector('#drawer-title').textContent=row.getAttribute('aria-label').replace('Open ','');drawer.dataset.visible='true'});`);
	}
	if (pathname === "/network") {
		return pageShell("Capture network evidence", "Native browser command", `<h2 class="section-title">Warehouse synchronization</h2><div class="metric-grid"><div class="metric"><div class="metric-label">Products</div><div class="metric-value" id="products">1,284</div></div><div class="metric"><div class="metric-label">Warehouses</div><div class="metric-value">6</div></div><div class="metric"><div class="metric-label">Exceptions</div><div class="metric-value" id="exceptions">12</div></div></div><div class="sync-panel"><div class="sync-copy"><strong id="sync-title">Inventory ready</strong><span id="sync-detail">Last synchronized 18 minutes ago</span></div><button class="primary" id="sync-button" type="button" aria-label="Sync inventory">Sync inventory</button></div><div class="request" id="request-row" data-visible="false"><span class="method">GET</span><span>/api/inventory?warehouse=west</span><span class="http-ok">200</span></div>`, `
document.querySelector('#sync-button').addEventListener('click',async()=>{const button=document.querySelector('#sync-button'),title=document.querySelector('#sync-title'),detail=document.querySelector('#sync-detail');button.disabled=true;button.textContent='Syncing...';button.classList.add('spin');title.textContent='Request in flight';detail.textContent='Waiting for warehouse API';const data=await fetch('/api/inventory?warehouse=west').then(r=>r.json());document.querySelector('#products').textContent=data.products.toLocaleString();document.querySelector('#exceptions').textContent=String(data.exceptions);document.querySelector('#request-row').dataset.visible='true';title.textContent='Inventory synchronized';detail.textContent='Warehouse response applied';button.textContent='Synced';button.classList.remove('spin');document.documentElement.dataset.sync='done'});`);
	}
	return pageShell("Verify a form workflow", "Observe, act, verify", `<h2 class="section-title">Create support case</h2><form id="case-form"><div class="field-grid"><label>Company<input id="company" aria-label="Company" autocomplete="off" placeholder="Company name"></label><label>Contact email<input id="email" aria-label="Contact email" type="email" autocomplete="off" placeholder="name@company.com"></label><label class="field full">Priority<select id="priority" aria-label="Priority"><option value="">Select priority</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label></div><div class="form-actions"><button class="primary" id="create-case" type="submit">Create case</button></div></form><div class="success" id="case-success" data-visible="false"><span class="check">✓</span><span>Case BP-1042 created and verified</span></div>`, `
document.querySelector('#case-form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#case-success').dataset.visible='true';document.documentElement.dataset.caseCreated='true'});`);
}

async function startFixtureServer() {
	const server = http.createServer(async (req, res) => {
		const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
		if (requestUrl.pathname === "/api/inventory") {
			await delay(1_200);
			const body = JSON.stringify({ products: 1298, exceptions: 4, warehouse: "west" });
			res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
			res.end(body);
			return;
		}
		const body = fixturePage(requestUrl.pathname);
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
		res.end(body);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not expose a TCP port");
	return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function browserCandidates() {
	const candidates = process.platform === "win32"
		? [
			path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
			path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		]
		: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
	const found = [];
	for (const candidate of candidates) {
		try { await access(candidate); found.push(candidate); } catch { /* try the next path */ }
	}
	return found;
}

async function daemonJson(daemon, pathname, init = {}, timeoutMs = 10_000) {
	const response = await fetch(`http://${daemon.controlHost}:${daemon.controlPort}${pathname}`, {
		...init,
		headers: {
			"x-browser-pilot-daemon-token": daemon.token,
			...(init.body ? { "content-type": "application/json" } : {}),
			...init.headers,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});
	const value = await response.json();
	if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(value)}`);
	return value;
}

function resultText(result) {
	return Array.isArray(result?.content) ? result.content.map((item) => typeof item?.text === "string" ? item.text : "").join("\n") : "";
}

function resultEnvelope(result, label) {
	try { return JSON.parse(resultText(result)); } catch { throw new Error(`${label} did not return JSON: ${resultText(result)}`); }
}

async function invoke(daemon, tool, params, timeoutMs = 12_000) {
	const result = await daemonJson(daemon, "/invoke", {
		method: "POST",
		body: JSON.stringify({ tool, params, cwd: root, contractIdentity: daemon.contractIdentity }),
	}, timeoutMs);
	if (result.ok !== true || result.terminate === true || result.isError === true) throw new Error(`${tool} failed: ${resultText(result) || JSON.stringify(result)}`);
	return result;
}

async function waitForStatus(daemon, predicate, label) {
	const deadline = Date.now() + launchTimeoutMs;
	let last;
	do {
		last = await daemonJson(daemon, "/status?tabs=1");
		if (predicate(last)) return last;
		await delay(250);
	} while (Date.now() < deadline);
	throw new Error(`${label} timed out; last status=${JSON.stringify(last)}`);
}

async function launchBrowser(daemon, fixtureUrl, profileRoot) {
	const failures = [];
	for (const executable of await browserCandidates()) {
		const profileDir = await mkdtemp(path.join(profileRoot, "browser-"));
		const child = spawn(executable, [
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--remote-debugging-port=0",
			"--force-device-scale-factor=1",
			`--user-data-dir=${profileDir}`,
			`--disable-extensions-except=${extensionDir}`,
			`--load-extension=${extensionDir}`,
			"--window-size=1280,800",
			fixtureUrl,
		], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
		child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4_000); });
		try {
			const status = await waitForStatus(daemon, (value) => value.extensionConnected === true && value.tabs?.some((tab) => String(tab.url || "").startsWith(fixtureUrl)), `extension handshake via ${executable}`);
			return { child, executable, profileDir, status };
		} catch (error) {
			child.kill();
			failures.push({ executable, error: error instanceof Error ? error.message : String(error), output });
		}
	}
	throw new Error(`no browser completed the extension handshake: ${JSON.stringify(failures)}`);
}

async function closeBrowser(child, profileDir) {
	try {
		const [portLine, socketPath] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
		const endpoint = `ws://127.0.0.1:${Number(portLine)}${socketPath}`;
		await new Promise((resolve) => {
			const socket = new WebSocket(endpoint);
			const timer = setTimeout(() => { socket.terminate(); resolve(); }, 2_000);
			socket.once("open", () => socket.send(JSON.stringify({ id: 1, method: "Browser.close" })));
			socket.once("close", () => { clearTimeout(timer); resolve(); });
			socket.once("error", () => { clearTimeout(timer); resolve(); });
		});
	} catch { child.kill(); }
	await delay(500);
	if (child.exitCode === null) child.kill();
}

function actionRef(observation, name) {
	const query = name.toLowerCase();
	const item = observation.actionSpace?.items?.find((candidate) => String(candidate.name || "").toLowerCase().includes(query));
	if (!item?.ref) throw new Error(`action ref not found for ${name}: ${JSON.stringify(observation.actionSpace)}`);
	return item.ref;
}

async function trace(daemon, targetRef, tool, detail, state = "done") {
	await invoke(daemon, "browser_execute", {
		targetRef,
		script: `window.demoTrace(${JSON.stringify(tool)},${JSON.stringify(detail)},${JSON.stringify(state)});true`,
	});
}

async function setRefValue(daemon, ref, value) {
	return await invoke(daemon, "browser_execute", {
		refs: { field: ref },
		script: `(async()=>{const field=browserPilot.refs.field;if(field.tagName==='SELECT'){field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}))}else await browserPilot.setValue(field,${JSON.stringify(value)});scrollTo(0,0);return true})()`,
	});
}

async function navigate(daemon, targetRef, url) {
	await invoke(daemon, "browser_execute", { targetRef, script: `location.href=${JSON.stringify(url)};true` });
	await waitForStatus(daemon, (status) => status.tabs?.some((tab) => tab.targetRef === targetRef && String(tab.url || "").startsWith(url)), `navigation to ${url}`);
	await delay(250);
}

async function encodeGif(frameDir, frames, outputPath) {
	const manifest = frames.flatMap((frame, index) => [`file '${String(index).padStart(3, "0")}.png'`, `duration ${frame.duration}`]);
	manifest.push(`file '${String(frames.length - 1).padStart(3, "0")}.png'`);
	await writeFile(path.join(frameDir, "frames.txt"), `${manifest.join("\n")}\n`, "utf8");
	await new Promise((resolve, reject) => {
		const child = spawn("ffmpeg", [
			"-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt",
			"-vf", "scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=48:stats_mode=full[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle",
			"-fps_mode", "vfr", "-gifflags", "+transdiff", "-loop", "0", outputPath,
		], { cwd: frameDir, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
	});
}

function recorder(daemon, targetRef, workDir) {
	let index = 0;
	const frames = [];
	return {
		frames,
		async capture(duration = 0.8) {
			await invoke(daemon, "browser_execute", { targetRef, script: "document.activeElement?.blur();scrollTo(0,0);for(const el of document.querySelectorAll('html,body,main,.layout,.work')){el.scrollTop=0;el.scrollLeft=0}true" });
			await delay(100);
			const shot = resultEnvelope(await invoke(daemon, "browser_screenshot", { targetRef }), "browser_screenshot");
			if (!shot.saved?.path) throw new Error(`screenshot path missing: ${JSON.stringify(shot)}`);
			const destination = path.join(workDir, `${String(index).padStart(3, "0")}.png`);
			await copyFile(shot.saved.path, destination);
			frames.push({ duration });
			index += 1;
		},
	};
}

async function captureForm(daemon, targetRef, baseUrl, tempRoot) {
	await navigate(daemon, targetRef, `${baseUrl}/form`);
	const dir = path.join(tempRoot, "form");
	await mkdir(dir);
	const record = recorder(daemon, targetRef, dir);
	await record.capture(1.1);
	const observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, fresh: true }), "browser_observe");
	await trace(daemon, targetRef, "browser_observe", `${observed.actionSpace.coverage.captured} actionable controls mapped`);
	await record.capture(0.9);
	const company = actionRef(observed, "Company");
	const email = actionRef(observed, "Contact email");
	const submit = actionRef(observed, "Create case");
	await setRefValue(daemon, company, "North");
	await record.capture(0.45);
	await setRefValue(daemon, company, "Northwind Labs");
	await trace(daemon, targetRef, "browser_execute", "Company value written through observed ref");
	await record.capture(0.65);
	await setRefValue(daemon, email, "ops@northwind.example");
	await invoke(daemon, "browser_execute", {
		targetRef,
		script: "(()=>{const field=document.querySelector('#priority');field.value='high';field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));return true})()",
	});
	await trace(daemon, targetRef, "browser_execute", "Contact and priority fields completed");
	await record.capture(0.8);
	const submitted = resultEnvelope(await invoke(daemon, "browser_command", {
		targetRef,
		command: { cmd: "input.ref", action: "click", ref: submit },
		expect: "document.documentElement.dataset.caseCreated==='true'",
	}), "browser_command input.ref");
	await trace(daemon, targetRef, "browser_command", `Trusted click · verification ${submitted.verification?.status || "met"}`);
	await record.capture(1.8);
	await encodeGif(dir, record.frames, path.join(outputDir, "demo-form-verification.gif"));
}

async function captureTable(daemon, targetRef, baseUrl, tempRoot) {
	await navigate(daemon, targetRef, `${baseUrl}/table`);
	const dir = path.join(tempRoot, "table");
	await mkdir(dir);
	const record = recorder(daemon, targetRef, dir);
	await record.capture(1.1);
	let observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, fresh: true }), "browser_observe");
	await trace(daemon, targetRef, "browser_observe", `${observed.actionSpace.coverage.captured} actions across invoice records`);
	await record.capture(0.8);
	const filter = actionRef(observed, "Filter invoices");
	await setRefValue(daemon, filter, "over");
	await record.capture(0.45);
	await setRefValue(daemon, filter, "overdue");
	await trace(daemon, targetRef, "browser_execute", "Filtered table to overdue records");
	await record.capture(0.9);
	observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, fresh: true }), "filtered browser_observe");
	const invoice = actionRef(observed, "Open invoice INV-2048");
	await invoke(daemon, "browser_command", {
		targetRef,
		command: { cmd: "input.ref", action: "click", ref: invoice },
		expect: "document.querySelector('#invoice-drawer').dataset.visible==='true'",
	});
	await trace(daemon, targetRef, "browser_command", "Opened INV-2048 with verified native input");
	await record.capture(1.8);
	await encodeGif(dir, record.frames, path.join(outputDir, "demo-structured-research.gif"));
}

async function captureNetwork(daemon, targetRef, baseUrl, tempRoot) {
	await navigate(daemon, targetRef, `${baseUrl}/network`);
	const dir = path.join(tempRoot, "network");
	await mkdir(dir);
	const record = recorder(daemon, targetRef, dir);
	await record.capture(1.1);
	const observed = resultEnvelope(await invoke(daemon, "browser_observe", { targetRef, fresh: true }), "browser_observe");
	const sync = actionRef(observed, "Sync inventory");
	await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.start", clear: true } });
	await trace(daemon, targetRef, "browser_command", "Network capture armed for the selected tab");
	await record.capture(0.9);
	await invoke(daemon, "browser_command", { targetRef, command: { cmd: "input.ref", action: "click", ref: sync } });
	await record.capture(0.75);
	await invoke(daemon, "browser_execute", {
		targetRef,
		readOnly: true,
		script: "new Promise(resolve=>{const done=()=>document.documentElement.dataset.sync==='done';if(done())return resolve(true);const timer=setInterval(()=>{if(done()){clearInterval(timer);resolve(true)}},50)})",
	}, 5_000);
	await record.capture(0.85);
	const network = resultText(await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.list", limit: 20 } }));
	if (!network.includes("/api/inventory")) throw new Error(`network evidence missing inventory request: ${network}`);
	await trace(daemon, targetRef, "browser_command", "GET /api/inventory · 200 captured as evidence");
	await record.capture(1.8);
	await invoke(daemon, "browser_command", { targetRef, command: { cmd: "network.stop" } });
	await encodeGif(dir, record.frames, path.join(outputDir, "demo-network-evidence.gif"));
}

await import("./build-bridge.mjs");
await mkdir(outputDir, { recursive: true });
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-readme-demos-"));
const profileRoot = await mkdtemp(path.join(os.tmpdir(), "browser-pilot-demo-profile-"));
const fixture = await startFixtureServer();
const { startDaemon } = await import("../src/apps/daemon/server.ts");
const daemon = await startDaemon({ writeLock: false, startBridgeEagerly: true });
let browser;
try {
	browser = await launchBrowser(daemon, `${fixture.url}/form`, profileRoot);
	const tab = browser.status.tabs.find((item) => String(item.url || "").startsWith(fixture.url));
	const targetRef = tab?.targetRef || tab?.tabHandle;
	if (!targetRef) throw new Error(`fixture tab had no stable targetRef: ${JSON.stringify(tab)}`);
	await captureForm(daemon, targetRef, fixture.url, tempRoot);
	await captureTable(daemon, targetRef, fixture.url, tempRoot);
	await captureNetwork(daemon, targetRef, fixture.url, tempRoot);
	console.log(JSON.stringify({ ok: true, browser: browser.executable, outputs: ["demo-form-verification.gif", "demo-structured-research.gif", "demo-network-evidence.gif"] }, null, 2));
} finally {
	if (browser) await closeBrowser(browser.child, browser.profileDir);
	await daemon.close();
	await fixture.close();
	await rm(tempRoot, { recursive: true, force: true });
	await rm(profileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
