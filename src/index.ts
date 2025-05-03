import { z, ZodIssueCode } from 'zod';
import { DurableObject } from 'cloudflare:workers';

interface Env {
	CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
}

interface ChatMessage {
	userName: string;
	message?: string;
}

interface ChatClientMetadata {
	userName: string;
}

// preprocessing zod validation by parsing stringified JSON
const parseJsonPreprocessor = (value: any, ctx: z.RefinementCtx) => {
	if (typeof value === 'string') {
		try {
			return JSON.parse(value);
		} catch (e) {
			ctx.addIssue({
				code: ZodIssueCode.custom,
				message: (e as Error).message,
			});
		}
	}

	return value;
};

const chatMessageSchema = z.preprocess(
	parseJsonPreprocessor,
	z.object({
		userName: z
			.string()
			.min(1, { message: 'Name is too short' })
			.max(32, { message: 'Name is too long' })
			.regex(/^[a-zA-Z][0-9a-zA-Z-_ ]/),
		message: z.string().min(1, { message: 'Message is too short' }).max(255, { message: 'Message too long' }).optional(),
	})
);

// Worker
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname.slice(1).split('/');
		const room = path[0] && path[0].length > 0 ? path[0].toLowerCase() : 'default';

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
		let id = env.CHAT_ROOM.idFromName(room);
		let stub = env.CHAT_ROOM.get(id);

		return stub.fetch(request);
	},
};

// Durable Object
export class ChatRoom extends DurableObject {
	clients: Map<WebSocket, ChatClientMetadata | undefined>;
	storage: DurableObjectStorage;

	constructor(state: DurableObjectState, env: Env) {
		// This is reset whenever the constructor runs because
		// regular WebSockets do not survive Durable Object resets.
		//
		// WebSockets accepted via the Hibernation API can survive
		// a certain type of eviction.
		super(state, env);

		// client sessions bound to this chat room instance
		this.clients = new Map();
		this.ctx.getWebSockets().forEach((websocket) => {
			this.clients.set(websocket, undefined);
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

		// creating a Map entry with user data undefined
		// user data should arrive with the first message
		this.clients.set(server, undefined);

		// sending number of users in the chat room
		this.broadcastClientsCount();

		// sending 100 last messages to the client
		await this.sendHistory(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	// hibernation websocket methods
	async webSocketMessage(ws: WebSocket, message: string) {
		const userMetaData = this.clients.get(ws);

		// validating message data
		const parsedMessage = chatMessageSchema.safeParse(message);

		if (!parsedMessage.success) {
			const errorMessage: ChatMessage = {
				message: `error:${parsedMessage.error.errors[0].message}`,
				userName: 'system',
			};
			ws.send(JSON.stringify(errorMessage));
			return;
		}

		// populating user metadata from the message data
		if (!parsedMessage.data.userName) {
			// if no user data found generating metadata from the first message
			const userName = parsedMessage.data.userName;
			if (!userMetaData?.userName) {
				// attach name to the webSocket so it survives hibernation
				ws.serializeAttachment({ ...ws.deserializeAttachment(), userName });
			}

			this.clients.set(ws, { userName });
		}

		// if message contains message broadcasting it to the room clients
		if (parsedMessage.data.message) {
			// broadcasting message
			this.clients.forEach((_, websocket) => {
				try {
					websocket.send(JSON.stringify(parsedMessage.data));
				} catch (error) {
					this.clients.delete(websocket);
					this.broadcastClientsCount();
				}
			});

			// saving message to storage
			const key = new Date().toISOString();
			await this.storage.put(key, JSON.stringify(parsedMessage.data));
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
		// If the client closes the connection, the runtime will invoke the webSocketClose() handler.
		ws.close(code, 'Durable Object is closing WebSocket');
		this.clients.delete(ws);
		this.broadcastClientsCount();
	}

	broadcastClientsCount() {
		const message: ChatMessage = {
			message: `user_count:${this.clients.size}`,
			userName: 'system',
		};
		this.clients.forEach((metadata, websocket) => {
			try {
				websocket.send(JSON.stringify(message));
			} catch (error) {
				this.clients.delete(websocket);
			}
		});
	}

	async sendHistory(ws: WebSocket) {
		// Load the last 100 messages from the chat history stored on disk, and send them to the
		// client.
		const storage = await this.storage.list({ reverse: true, limit: 100 });
		const backlog = [...storage.values()] as ChatMessage[];
		const historyMessage: ChatMessage = {
			userName: 'system',
			message: `history:${JSON.stringify(backlog.reverse())}`,
		};

		ws.send(JSON.stringify(historyMessage));
	}
}
