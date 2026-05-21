import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { BrowserBridgeError } from "./errors";
import { isAllowedBridgeOrigin, normalizeErrorMessage } from "./bridgeUtils";

export class BrowserBridgeHttpServer {
	readonly host: string;
	readonly port: number;
	private readonly onConnection: (ws: WebSocket) => void;
	private httpServer?: http.Server;
	private wss?: WebSocketServer;
	private starting?: Promise<void>;

	constructor(host: string, port: number, onConnection: (ws: WebSocket) => void) {
		this.host = host;
		this.port = port;
		this.onConnection = onConnection;
	}

	get running(): boolean {
		return !!this.httpServer?.listening;
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.starting) return this.starting;
		this.starting = new Promise<void>((resolve, reject) => {
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

			server.once("error", (error) => {
				this.starting = undefined;
				reject(new BrowserBridgeError("BRIDGE_START_FAILED", normalizeErrorMessage(error), { host: this.host, port: this.port }));
			});
			server.listen(this.port, this.host, () => {
				this.httpServer = server;
				this.wss = wss;
				this.starting = undefined;
				resolve();
			});
		});
		return this.starting;
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
