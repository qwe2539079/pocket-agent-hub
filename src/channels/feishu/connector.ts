import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import * as Lark from "@larksuiteoapi/node-sdk";

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
  type ParsedFeishuMessage,
} from "./protocol.js";

interface FeishuTokenResponse {
  tenant_access_token?: string;
  app_access_token?: string;
  expire?: number;
}

interface FeishuWsEvent {
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    message_type?: string;
    content?: string;
    create_time?: string;
  };
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

  protected async routeParsedMessage(parsed: ParsedFeishuMessage | null): Promise<string | null> {
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
      throw new Error(`Feishu auth returned no token`);
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
  #client?: Lark.WSClient;
  #started = false;

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#client = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
    });

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: FeishuWsEvent) => {
        const parsed = parseFeishuWsMessage(data);
        const replyText = await this.routeParsedMessage(parsed);
        if (parsed && replyText) {
          await this.sendTextMessage(parsed.chatId, replyText);
        }
      },
    });

    await this.#client.start({ eventDispatcher });
    console.log("[feishu] connected via official websocket client");
  }
}

function parseFeishuWsMessage(event: FeishuWsEvent): ParsedFeishuMessage | null {
  const message = event.message;
  if (!message || message.message_type !== "text" || !message.chat_id || !message.message_id || !message.content) {
    return null;
  }

  const senderId =
    event.sender?.sender_id?.open_id ??
    event.sender?.sender_id?.user_id ??
    event.sender?.sender_id?.union_id;

  if (!senderId) {
    return null;
  }

  let text = "";
  try {
    const parsedContent = JSON.parse(message.content) as { text?: string };
    text = parsedContent.text?.trim() ?? "";
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  return {
    eventId: message.message_id,
    chatId: message.chat_id,
    senderId,
    text,
    timestamp: message.create_time ?? new Date().toISOString(),
  };
}
