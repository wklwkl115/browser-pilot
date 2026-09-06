import http from "node:http";

const shell = (
	title,
	body,
	script = "",
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;

function taskPage(pathname, run, crossOrigin) {
	if (pathname === "/async-form")
		return shell(
			"Support request",
			`
		<form id="request-form"><label>Request title <input id="request-title" required></label>
		<button type="submit">Send request</button></form><p id="result" role="status">Draft</p>`,
			`
		document.querySelector('#request-form').onsubmit = async (event) => {
			event.preventDefault(); const button = event.submitter; button.disabled = true;
			const response = await fetch('/api/cases?run=${run}', {method:'POST', body:document.querySelector('#request-title').value});
			const receipt = await response.json();
			const data = await (await fetch('/api/cases/' + receipt.id + '?run=${run}', {cache:'no-store'})).json();
			document.querySelector('#result').textContent = data.id;
			document.querySelector('#result').dataset.saved = 'yes'; button.disabled = false;
		};`,
		);
	if (pathname === "/invoices")
		return shell(
			"Invoice lookup",
			`
		<label>Invoice status <select id="status-filter"><option value="all">All</option><option value="overdue">Overdue</option></select></label>
		<button id="load-invoices">Load invoices</button><div id="invoice-list"></div>`,
			`
		document.querySelector('#load-invoices').onclick = async () => {
			const data = await (await fetch('/api/invoices')).json();
			const filter = document.querySelector('#status-filter').value;
			const list = document.querySelector('#invoice-list'); list.replaceChildren();
			for (const invoice of data.filter(row => filter === 'all' || row.status === filter)) {
				const link = document.createElement('a'); link.textContent = 'Open ' + invoice.id;
				link.href = '/invoice/' + invoice.id; list.append(link);
			}
			list.dataset.ready = 'yes';
		};`,
		);
	if (pathname.startsWith("/invoice/"))
		return shell(
			"Invoice details",
			`<p id="invoice-id">${pathname.endsWith("INV-OVERDUE") ? "INV-OVERDUE" : "INV-PAID"}</p>`,
		);
	if (pathname === "/rerender")
		return shell(
			"Draft editor",
			`
		<button id="refresh">Refresh action</button><button id="save-draft" onclick="window.savedCount++">Save draft</button>`,
			`
		window.savedCount = 0;
		document.querySelector('#refresh').onclick = () => { const old = document.querySelector('#save-draft'); old.replaceWith(old.cloneNode(true)); };`,
		);
	if (pathname === "/guard")
		return shell(
			"Stale target guard",
			`
		<button id="replace">Replace action</button><button id="safe-action">Safe action</button>`,
			`
		window.dangerCount = 0;
		document.querySelector('#replace').onclick = () => {
			const next = document.createElement('button'); next.id = 'danger-action'; next.textContent = 'Delete everything';
			next.onclick = () => { window.dangerCount++; }; document.querySelector('#safe-action').replaceWith(next);
		};`,
		);
	if (pathname === "/failed-submit")
		return shell(
			"Failed request",
			`
		<button id="send-failed">Send failing request</button><p id="status" role="status">Ready</p>`,
			`
		window.savedCount = 0;
		document.querySelector('#send-failed').onclick = async () => {
			document.querySelector('#status').textContent = 'Saved';
			const response = await fetch('/api/failure?run=${run}', {method:'POST'});
			const status = document.querySelector('#status'); status.dataset.httpStatus = String(response.status);
			if (response.ok) { window.savedCount++; status.textContent = 'Saved'; }
			else { status.textContent = 'Not saved'; status.dataset.failed = 'yes'; }
		};`,
		);
	if (pathname === "/spa")
		return shell(
			"Workspace settings",
			`
		<label>Workspace name <input id="workspace-name" value="Original"></label>
		<button id="settings">Open settings</button><section id="route">Home</section>`,
			`
		window.documentBoot = crypto.randomUUID();
		document.querySelector('#settings').onclick = () => { history.pushState({}, '', '/spa/settings'); document.querySelector('#route').textContent = 'Settings'; };`,
		);
	if (pathname === "/tab-owner")
		return shell(
			"Tab ownership",
			`<button id="save" onclick="window.savedCount++">Save draft</button>`,
			"window.savedCount = 0;",
		);
	if (pathname === "/occlusion")
		return shell(
			"Occlusion guard",
			`
		<button id="cover">Cover action</button><button id="protected" onclick="window.protectedCount++">Protected action</button>`,
			`
		window.protectedCount = 0;
		document.querySelector('#cover').onclick = () => {
			const rect = document.querySelector('#protected').getBoundingClientRect(); const cover = document.createElement('div');
			Object.assign(cover.style, {position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'2147483647'});
			document.body.append(cover);
		};`,
		);
	if (pathname.startsWith("/frames/")) {
		const mode = pathname.split("/").at(-1);
		const child =
			mode === "same" ? "/frame-child" : mode === "nested" ? "/frame-middle" : crossOrigin + "/frame-child";
		return shell(
			"Frame host",
			`<label>Parent value <input id="frame-value" value="parent"></label><iframe id="child-frame" title="Child form" src="${child}"></iframe>`,
		);
	}
	if (pathname === "/frame-middle")
		return shell("Middle frame", `<iframe title="Nested child" src="${crossOrigin}/frame-child"></iframe>`);
	if (pathname === "/frame-child")
		return shell("Child form", '<label>Child value <input id="frame-value" value="child"></label>');
	return shell("Browser task evaluation", "<p>Controlled local fixtures only.</p>");
}

export async function startEvaluationFixtures() {
	const submissions = new Map();
	const failedRequests = new Map();
	let crossOrigin;
	const timers = new Set();
	const later = (delay, callback) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			callback();
		}, delay);
		timers.add(timer);
	};
	const handle = (req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const run = Number(url.searchParams.get("run")) || 0;
		const send = (value, type = "application/json", status = 200) => {
			if (res.destroyed) return;
			res.writeHead(status, {
				"content-type": type,
				"cache-control": "no-store",
				"content-security-policy": `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self' ${crossOrigin}; object-src 'none'`,
			});
			res.end(type === "application/json" ? JSON.stringify(value) : value);
		};
		if (url.pathname === "/api/cases" && req.method === "POST") {
			let text = "";
			req.on("data", (chunk) => {
				text += chunk;
				if (text.length > 4096) req.destroy();
			});
			req.on("end", () => {
				submissions.set(run, [...(submissions.get(run) ?? []), text]);
				later(650, () => send({ id: "CASE-001" }));
			});
		} else if (url.pathname === "/api/cases/CASE-001" && req.method === "GET") {
			const records = submissions.get(run) ?? [];
			if (records.length) send({ id: "CASE-001", title: records[records.length - 1] });
			else send({ error: "not found" }, "application/json", 404);
		} else if (url.pathname === "/api/failure" && req.method === "POST") {
			failedRequests.set(run, (failedRequests.get(run) ?? 0) + 1);
			later(750, () => send({ error: "fixture unavailable" }, "application/json", 503));
		} else if (url.pathname === "/api/invoices")
			later(950, () =>
				send([
					{ id: "INV-PAID", status: "paid" },
					{ id: "INV-OVERDUE", status: "overdue" },
				]),
			);
		else send(taskPage(url.pathname, run, crossOrigin), "text/html; charset=utf-8");
	};
	const childServer = http.createServer(handle);
	const server = http.createServer(handle);
	const listen = (instance) =>
		new Promise((resolve, reject) => {
			instance.once("error", reject);
			instance.listen(0, "127.0.0.1", resolve);
		});
	const close = (instance) =>
		new Promise((resolve) => {
			instance.close(resolve);
			instance.closeAllConnections();
		});
	try {
		await listen(childServer);
		crossOrigin = `http://127.0.0.1:${childServer.address().port}`;
		await listen(server);
	} catch (error) {
		await Promise.all([close(server), close(childServer)]);
		throw error;
	}
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		crossOrigin,
		submissions: (run) => submissions.get(run) ?? [],
		failedRequests: (run) => failedRequests.get(run) ?? 0,
		close: async () => {
			for (const timer of timers) clearTimeout(timer);
			await Promise.all([close(server), close(childServer)]);
		},
	};
}
