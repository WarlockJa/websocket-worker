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

	constructor(ctx: DurableObjectState, env: Env) {
		// This is reset whenever the constructor runs because
		// regular WebSockets do not survive Durable Object resets.
		//
		// WebSockets accepted via the Hibernation API can survive
		// a certain type of eviction, but we will not cover that here.
		super(ctx, env);

		this.clients = new Set();
		this.ctx.getWebSockets().forEach((websocket) => {
			this.clients.add(websocket);
		});

		console.log('CLIENTS: ', this.clients, this.clients.size);
	}

	async fetch(request: Request): Promise<Response> {
		// Creates two ends of a WebSocket connection.
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		// Calling `accept()` tells the runtime that this WebSocket is to begin terminating
		// request within the Durable Object. It has the effect of "accepting" the connection,
		// and allowing the WebSocket to send and receive messages.
		server.accept();
		this.clients.add(server);

		this.broadcastClientsCount();

		// Upon receiving a message from the client, the server replies with the same message,
		// and the total number of connections with the "[Durable Object]: " prefix
		server.addEventListener('message', (event: MessageEvent) => {
			this.clients.forEach((ws) => {
				try {
					ws.send(event.data);
				} catch (error) {
					this.clients.delete(ws);
				}
			});
		});

		// If the client closes the connection, the runtime will close the connection too.
		server.addEventListener('close', (cls: CloseEvent) => {
			server.close(cls.code, 'Durable Object is closing WebSocket');
			this.clients.delete(server);

			this.broadcastClientsCount();
		});

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
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
