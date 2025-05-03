import { DurableObject } from 'cloudflare:workers';

interface Env {
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
}

// Worker
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// Expect to receive a WebSocket Upgrade request.
		// If there is one, accept the request and return a WebSocket Response.
		const upgradeHeader = request.headers.get('Upgrade');
		if (!upgradeHeader || upgradeHeader !== 'websocket') {
			return new Response('Durable Object expected Upgrade: websocket', {
				status: 426,
			});
		}

		// This example will refer to the same Durable Object,
		// since the name "foo" is hardcoded.
		let id = env.CHAT_ROOM.idFromName('default');
		let stub = env.CHAT_ROOM.get(id);

		return stub.fetch(request);
	},
};

// Durable Object
export class ChatRoom extends DurableObject {
	clients: Set<WebSocket>;
	storage: DurableObjectStorage;

	constructor(state: DurableObjectState, env: Env) {
		// This is reset whenever the constructor runs because
		// regular WebSockets do not survive Durable Object resets.
		//
		// WebSockets accepted via the Hibernation API can survive
		// a certain type of eviction, but we will not cover that here.
		super(state, env);

		// client sessions bound to this chat room instance
		this.clients = new Set();
		this.ctx.getWebSockets().forEach((websocket) => {
			this.clients.add(websocket);
		});

		// previous messages storage
		this.storage = state.storage;
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `acceptWebSocket()` informs the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		// Unlike `ws.accept()`, `state.acceptWebSocket(ws)` informs the Workers Runtime that the WebSocket
		// is "hibernatable", so the runtime does not need to pin this Durable Object to memory while
		// the connection is open. During periods of inactivity, the Durable Object can be evicted
		// from memory, but the WebSocket connection will remain open. If at some later point the
		// WebSocket receives a message, the runtime will recreate the Durable Object
		// (run the `constructor`) and deliver the message to the appropriate handler.
		this.ctx.acceptWebSocket(server);

		this.clients.add(server);

		this.broadcastClientsCount();

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	// hibernation websocket methods
	async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
		this.clients.forEach((ws) => {
			try {
				ws.send(message);
			} catch (error) {
				this.clients.delete(ws);
				this.broadcastClientsCount();
			}
		});
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, 'Durable Object is closing WebSocket');
		this.broadcastClientsCount();
	}

	broadcastClientsCount() {
		this.clients.forEach((client) => {
			try {
				client.send(`SYSTEM_USER_COUNT: ${this.clients.size}`);
			} catch (error) {
				this.clients.delete(client);
			}
		});
	}
}
