import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END } from "./browserBridgeConfig.js";
import { BrowserBridgeError } from "../../utils/errors.js";
import { isAllowedBridgeOrigin, normalizeErrorMessage } from "./bridgeUtils.js";

export const DEFAULT_BROWSER_BRIDGE_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

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
	private readonly maxConnections: number;
	private readonly maxPayloadBytes: number;
	private httpServer?: http.Server;
	private wss?: WebSocketServer;
	private starting?: Promise<void>;

	constructor(host: string, port: number, onConnection: (ws: WebSocket) => void, options: { portRangeEnd?: number; maxConnections?: number; maxPayloadBytes?: number } = {}) {
		this.host = host;
		this.requestedPort = port;
		this.portRangeEnd = options.portRangeEnd && options.portRangeEnd >= port ? options.portRangeEnd : port;
		this.activePort = port;
		this.onConnection = onConnection;
		const configuredMax = Number(process.env.BROWSER_PILOT_BRIDGE_MAX_CONNECTIONS ?? options.maxConnections);
		const fallback = Math.max(8, (this.portRangeEnd - port + 1) * 4 || DEFAULT_BROWSER_BRIDGE_PORT_RANGE_END - port + 1);
		this.maxConnections = Number.isFinite(configuredMax) && configuredMax > 0 ? Math.floor(configuredMax) : fallback;
		const configuredMaxPayloadBytes = Number(process.env.BROWSER_PILOT_BRIDGE_MAX_PAYLOAD_BYTES ?? options.maxPayloadBytes);
		this.maxPayloadBytes = Number.isFinite(configuredMaxPayloadBytes) && configuredMaxPayloadBytes > 0
			? Math.floor(configuredMaxPayloadBytes)
			: DEFAULT_BROWSER_BRIDGE_MAX_PAYLOAD_BYTES;
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

	private activeConnectionCount(): number {
		return this.wss ? this.wss.clients.size : 0;
	}

	private createServer(): { server: http.Server; wss: WebSocketServer } {
		const server = http.createServer((req, res) => {
			if (req.url === "/health" || req.url === "/") {
				res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ ok: true, name: "browser-pilot", port: this.port, activeConnections: this.activeConnectionCount(), maxConnections: this.maxConnections, maxPayloadBytes: this.maxPayloadBytes }));
				return;
			}
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
		});

		const wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });
		server.on("upgrade", (req, socket, head) => {
			if (!isAllowedBridgeOrigin(req.headers.origin)) {
				const body = JSON.stringify({ ok: false, error: "Origin not allowed", rejectedOrigin: req.headers.origin ?? null, allowedOrigins: ["chrome-extension://*", "(no origin / null)"], hint: "Only chrome-extension:// origins and requests with no Origin header are accepted. If you are connecting from a web page or another extension, ensure the request originates from an allowed source." });
				socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n\r\n" + body);
				socket.destroy();
				return;
			}
			if (wss.clients.size >= this.maxConnections) {
				socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n\r\n" + JSON.stringify({ ok: false, error: "Browser bridge connection limit reached", maxConnections: this.maxConnections, activeConnections: wss.clients.size, hint: "Close unused browser tabs or sessions to free connections, or set the BROWSER_PILOT_BRIDGE_MAX_CONNECTIONS environment variable to a higher value." }));
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
				try {
					wss.close();
				} catch {
					/* best-effort websocket server close after listen failure */
				}
				try {
					server.close();
				} catch {
					/* best-effort http server close after listen failure */
				}
				lastError = error;
				if (!isAddressInUse(error)) break;
			}
		}
		const portRangeLabel = this.requestedPort === this.portRangeEnd ? String(this.requestedPort) : `${this.requestedPort}-${this.portRangeEnd}`;
		const hint = `Check if other processes are using port${this.requestedPort === this.portRangeEnd ? "" : "s"} ${portRangeLabel}, or set BROWSER_PILOT_BRIDGE_PORT / BROWSER_PILOT_BRIDGE_PORT_RANGE_END environment variables to use a different range.`;
		throw new BrowserBridgeError("BRIDGE_START_FAILED", normalizeErrorMessage(lastError), { host: this.host, port: this.requestedPort, portRangeEnd: this.portRangeEnd, triedPortRange: portRangeLabel, hint });
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => {
			if (!this.wss && !this.httpServer) { resolve(); return; }
			const wss = this.wss;
			if (wss) {
				for (const client of wss.clients) {
					try {
						client.close(1001, "server stopping");
					} catch {
						/* best-effort websocket client close during stop */
					}
				}
			}
			try {
				wss?.close();
			} catch {
				/* best-effort websocket server close during stop */
			}
			const server = this.httpServer;
			this.wss = undefined;
			this.httpServer = undefined;
			if (!server?.listening) { resolve(); return; }
			server.close(() => resolve());
		});
	}
}
