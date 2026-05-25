import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserBridgeError } from "./errors";
import { isAllowedBridgeOrigin, normalizeErrorMessage } from "./bridgeUtils";

function listen(server: http.Server, port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

function isAddressInUse(error: unknown): boolean {
	return !!error && typeof error === "object" && (error as { code?: unknown }).code === "EADDRINUSE";
}

export class BrowserBridgeHttpServer {
	readonly host: string;
	readonly requestedPort: number;
	readonly portRangeEnd: number;
	private activePort: number;
	private readonly onConnection: (ws: WebSocket) => void;
	private httpServer?: http.Server;
	private wss?: WebSocketServer;
	private starting?: Promise<void>;

	constructor(host: string, port: number, onConnection: (ws: WebSocket) => void, options: { portRangeEnd?: number } = {}) {
		this.host = host;
		this.requestedPort = port;
		this.portRangeEnd = options.portRangeEnd && options.portRangeEnd >= port ? options.portRangeEnd : port;
		this.activePort = port;
		this.onConnection = onConnection;
	}

	get port(): number {
		return this.activePort;
	}

	get running(): boolean {
		return !!this.httpServer?.listening;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.starting) return this.starting;
		this.starting = this.startOnAvailablePort().finally(() => { this.starting = undefined; });
		return this.starting;
	}

	private createServer(): { server: http.Server; wss: WebSocketServer } {
		const server = http.createServer((req, res) => {
			if (req.url === "/health" || req.url === "/") {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true, name: "pi-browser-tools", port: this.port }));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
		});

		const wss = new WebSocketServer({ noServer: true });
		server.on("upgrade", (req, socket, head) => {
			if (!isAllowedBridgeOrigin(req.headers.origin)) {
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
		});
		wss.on("connection", this.onConnection);
		return { server, wss };
	}

	private async startOnAvailablePort(): Promise<void> {
		let lastError: unknown;
		for (let port = this.requestedPort; port <= this.portRangeEnd; port += 1) {
			const { server, wss } = this.createServer();
			try {
				await listen(server, port, this.host);
				this.activePort = port;
				this.httpServer = server;
				this.wss = wss;
				return;
			} catch (error) {
				try { wss.close(); } catch {}
				try { server.close(); } catch {}
				lastError = error;
				if (!isAddressInUse(error)) break;
			}
		}
		throw new BrowserBridgeError("BRIDGE_START_FAILED", normalizeErrorMessage(lastError), { host: this.host, port: this.requestedPort, portRangeEnd: this.portRangeEnd });
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.wss && !this.httpServer) { resolve(); return; }
			try { this.wss?.close(); } catch {}
			const server = this.httpServer;
			this.wss = undefined;
			this.httpServer = undefined;
			if (!server?.listening) { resolve(); return; }
			server.close(() => resolve());
		});
	}
}
