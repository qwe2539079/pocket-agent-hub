import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { FeishuChannelConfig } from "../../config/types.js";
import type { HubRouter } from "../../core/router.js";
import type { ChannelConnector } from "../../core/types.js";
import {
  assertVerificationToken,
  buildHubMessage,
  isChallengeEvent,
  parseFeishuMessage,
  renderFeishuReply,
  type FeishuEventEnvelope,
} from "./protocol.js";

interface FeishuTokenResponse {
  tenant_access_token?: string;
  app_access_token?: string;
  expire?: number;
  code?: number;
  msg?: string;
}

interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  addEventListener(event: string, listener: (event: unknown) => void): void;
}

export class FeishuConnector implements ChannelConnector {
  readonly id = "feishu";
  readonly #transport: ChannelConnector;

  constructor(
    private readonly config: FeishuChannelConfig,
    router: HubRouter,
  ) {
    this.#transport =
      config.mode === "websocket"
        ? new FeishuWebSocketConnector(config, router)
        : new FeishuWebhookConnector(config, router);
  }

  async start(): Promise<void> {
    await this.#transport.start();
  }
}

abstract class FeishuBaseConnector implements ChannelConnector {
  readonly id = "feishu";
  #tokenCache?: { value: string; expiresAt: number };

  constructor(
    protected readonly config: FeishuChannelConfig,
    protected readonly router: HubRouter,
  ) {}

  abstract start(): Promise<void>;

  protected get apiBaseUrl(): string {
    return this.config.apiBaseUrl ?? "https://open.feishu.cn";
  }

  protected async routeParsedMessage(parsed: ReturnType<typeof parseFeishuMessage>): Promise<string | null> {
    if (!parsed) {
      return null;
    }

    try {
      const hubMessage = buildHubMessage(parsed);
      const hubResponse = await this.router.route(hubMessage);
      return renderFeishuReply(hubResponse);
    } catch (error) {
      return error instanceof Error ? `Request failed: ${error.message}` : "Request failed.";
    }
  }

  protected async sendTextMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const apiUrl = `${this.apiBaseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Feishu send failed: ${response.status} ${body}`);
    }
  }

  protected async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#tokenCache && this.#tokenCache.expiresAt > now + 60_000) {
      return this.#tokenCache.value;
    }

    const response = await fetch(`${this.apiBaseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Feishu auth failed: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as FeishuTokenResponse;
    const token = payload.tenant_access_token ?? payload.app_access_token;
    if (!token) {
      throw new Error(`Feishu auth returned no token: ${JSON.stringify(payload)}`);
    }

    this.#tokenCache = {
      value: token,
      expiresAt: now + (payload.expire ?? 7200) * 1000,
    };

    return token;
  }

  protected async readJson(request: IncomingMessage): Promise<FeishuEventEnvelope> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(raw) as FeishuEventEnvelope;
  }

  protected writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(body)}\n`);
  }
}

class FeishuWebhookConnector extends FeishuBaseConnector {
  #serverStarted = false;

  async start(): Promise<void> {
    if (this.#serverStarted) {
      return;
    }

    const bindHost = this.config.bindHost ?? "0.0.0.0";
    const port = this.config.port ?? 8787;
    const path = this.config.path ?? "/feishu/events";

    await new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response, path);
      });

      server.on("error", reject);
      server.listen(port, bindHost, () => {
        this.#serverStarted = true;
        console.log(`[feishu] listening via webhook on http://${bindHost}:${port}${path}`);
        resolve();
      });
    });
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        this.writeJson(response, 200, { ok: true, channel: this.id, mode: "webhook" });
        return;
      }

      if (request.method !== "POST" || request.url !== path) {
        this.writeJson(response, 404, { ok: false, error: "Not found" });
        return;
      }

      const body = await this.readJson(request);
      assertVerificationToken(body, this.config.verificationToken);

      if (isChallengeEvent(body)) {
        this.writeJson(response, 200, { challenge: body.challenge });
        return;
      }

      const parsed = parseFeishuMessage(body);
      const replyText = await this.routeParsedMessage(parsed);
      if (parsed && replyText) {
        await this.sendTextMessage(parsed.chatId, replyText);
      }

      this.writeJson(response, 200, { ok: true, ignored: !parsed });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected Feishu handler error";
      this.writeJson(response, 400, { ok: false, error: message });
    }
  }
}

class FeishuWebSocketConnector extends FeishuBaseConnector {
  #socket?: WebSocketLike;
  #started = false;
  #reconnectTimer?: NodeJS.Timeout;
  #connecting = false;

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.#connecting) {
      return;
    }

    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error("Global WebSocket is unavailable in this Node runtime");
    }

    this.#connecting = true;
    const token = await this.getTenantAccessToken();
    const baseUrl = this.config.websocketUrl ?? "wss://msg-frontier.feishu.cn/ws/v2";
    const wsUrl = `${baseUrl}?app_access_token=${encodeURIComponent(token)}`;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocketCtor(wsUrl);

      socket.addEventListener("open", () => {
        this.#socket = socket;
        this.#connecting = false;
        console.log(`[feishu] connected via websocket: ${baseUrl}`);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("message", (event) => {
        void this.handleSocketMessage(event);
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          this.#connecting = false;
          reject(new Error("Feishu websocket connection failed"));
        }
      });

      socket.addEventListener("close", () => {
        this.#socket = undefined;
        this.#connecting = false;
        console.log("[feishu] websocket connection closed");
        if (!settled) {
          settled = true;
          reject(new Error("Feishu websocket connection closed before ready"));
        }
        this.scheduleReconnect();
      });
    }).catch((error) => {
      this.scheduleReconnect();
      throw error;
    });
  }

  private async handleSocketMessage(event: unknown): Promise<void> {
    const raw = extractSocketData(event);
    if (!raw) {
      return;
    }

    let payload: FeishuEventEnvelope & { type?: string; action?: string; message_id?: string };
    try {
      payload = JSON.parse(raw) as FeishuEventEnvelope & { type?: string; action?: string; message_id?: string };
    } catch {
      return;
    }

    if (payload.type === "ping" || payload.action === "ping") {
      this.sendSocketFrame({ type: "pong", message_id: payload.message_id });
      return;
    }

    if (isChallengeEvent(payload)) {
      this.sendSocketFrame({ challenge: payload.challenge });
      return;
    }

    const parsed = parseFeishuMessage(payload);
    const replyText = await this.routeParsedMessage(parsed);
    if (parsed && replyText) {
      await this.sendTextMessage(parsed.chatId, replyText);
    }
  }

  private sendSocketFrame(frame: Record<string, unknown>): void {
    if (!this.#socket || this.#socket.readyState !== 1) {
      return;
    }

    this.#socket.send(JSON.stringify(frame));
  }

  private scheduleReconnect(): void {
    if (!this.#started || this.#reconnectTimer) {
      return;
    }

    const delay = this.config.reconnectIntervalMs ?? 5_000;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.connect().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[feishu] websocket reconnect failed: ${message}`);
      });
    }, delay);
  }
}

function extractSocketData(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }

  return null;
}
