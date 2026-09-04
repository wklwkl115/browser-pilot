import http from "node:http";

const shell = (
	title,
	body,
	script = "",
) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>${title}</h1>${body}</main><script>${script}</script></body></html>`;

function taskPage(pathname, run) {
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
			const data = await response.json(); document.querySelector('#result').textContent = data.id;
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
	return shell("Browser task evaluation", "<p>Controlled local fixtures only.</p>");
}

export async function startEvaluationFixtures() {
	const submissions = new Map();
	const timers = new Set();
	const later = (delay, callback) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			callback();
		}, delay);
		timers.add(timer);
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://127.0.0.1");
		const run = Number(url.searchParams.get("run")) || 0;
		const send = (value, type = "application/json") => {
			if (res.destroyed) return;
			res.writeHead(200, {
				"content-type": type,
				"cache-control": "no-store",
				"content-security-policy":
					"default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'",
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
		} else if (url.pathname === "/api/invoices")
			later(950, () =>
				send([
					{ id: "INV-PAID", status: "paid" },
					{ id: "INV-OVERDUE", status: "overdue" },
				]),
			);
		else send(taskPage(url.pathname, run), "text/html; charset=utf-8");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		url: `http://127.0.0.1:${server.address().port}/`,
		submissions: (run) => submissions.get(run) ?? [],
		close: async () => {
			for (const timer of timers) clearTimeout(timer);
			await new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			});
		},
	};
}
