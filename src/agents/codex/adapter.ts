import { readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { WriteStream } from "node:fs";
import { resolve } from "node:path";

import type { AgentKind } from "../../config/types.js";
import { RunAdapter, type BuildArgsContext } from "../run-adapter.js";

export class CodexAdapter extends RunAdapter {
  readonly id: AgentKind = "codex";
  #profileChecked = false;
  #profileAvailable = false;

  protected async buildArgs({ prompt, projectPath, lastMessagePath, sandboxMode }: BuildArgsContext): Promise<string[]> {
    const args = ["exec", "-C", projectPath];

    if (await this.hasConfiguredProfile()) {
      args.push("--profile", this.config.defaultProfile);
    }

    args.push("--sandbox", sandboxMode ?? "danger-full-access");
    args.push("--output-last-message", lastMessagePath, prompt);
    return args;
  }

  protected attachStdio(
    child: ChildProcess,
    outputStream: WriteStream,
    _lastMessagePath: string,
  ): (() => void) | undefined {
    // codex writes the reply to --output-last-message itself, so the adapter
    // must not pre-open that file. The log gets stdout + stderr combined.
    child.stdout?.pipe(outputStream);
    child.stderr?.pipe(outputStream);
    return undefined;
  }

  private async hasConfiguredProfile(): Promise<boolean> {
    if (this.#profileChecked) {
      return this.#profileAvailable;
    }

    this.#profileChecked = true;
    const configPath = resolve(process.env.HOME ?? "", ".codex", "config.toml");

    try {
      const raw = await readFile(configPath, "utf8");
      this.#profileAvailable = raw.includes(`[profiles.${this.config.defaultProfile}]`);
    } catch {
      this.#profileAvailable = false;
    }

    return this.#profileAvailable;
  }
}
