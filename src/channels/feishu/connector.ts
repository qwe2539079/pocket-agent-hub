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

export class FeishuConnector implements ChannelConnector {
  readonly id = "feishu";
  #serverStarted = false;
  #tokenCache?: { value: string; expiresAt: number };

  constructor(
    private readonly config: FeishuChannelConfig,
    private readonly router: HubRouter,
  ) {}

  async start(): Promise<void> {
    if (this.#serverStarted) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response);
      });

      server.on("error", reject);
      server.listen(this.config.port, this.config.bindHost, () => {
        this.#serverStarted = true;
        console.log(`[feishu] listening on http://${this.config.bindHost}:${this.config.port}${this.config.path}`);
        resolve();
      });
    });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        this.writeJson(response, 200, { ok: true, channel: this.id });
        return;
      }

      if (request.method !== "POST" || request.url !== this.config.path) {
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
      if (!parsed) {
        this.writeJson(response, 200, { ok: true, ignored: true });
        return;
      }

      let replyText = "";
      try {
        const hubMessage = buildHubMessage(parsed);
        const hubResponse = await this.router.route(hubMessage);
        replyText = renderFeishuReply(hubResponse);
      } catch (error) {
        replyText = error instanceof Error ? `Request failed: ${error.message}` : "Request failed.";
      }

      await this.sendTextMessage(parsed.chatId, replyText);
      this.writeJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected Feishu handler error";
      this.writeJson(response, 400, { ok: false, error: message });
    }
  }

  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    const token = await this.getTenantAccessToken();
    const apiUrl = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";
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

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.#tokenCache && this.#tokenCache.expiresAt > now + 60_000) {
      return this.#tokenCache.value;
    }

    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal", {
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

  private async readJson(request: IncomingMessage): Promise<FeishuEventEnvelope> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(raw) as FeishuEventEnvelope;
  }

  private writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
    response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify(body)}\n`);
  }
}
