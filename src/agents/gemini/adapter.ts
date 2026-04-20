import type { ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";

import type { AgentKind } from "../../config/types.js";
import { RunAdapter, type BuildArgsContext } from "../run-adapter.js";

export class GeminiAdapter extends RunAdapter {
  readonly id: AgentKind = "gemini";

  protected async buildArgs({ prompt }: BuildArgsContext): Promise<string[]> {
    // Baseline: non-interactive `gemini -p <prompt>`. Adjust this if the
    // deployed gemini CLI uses a different flag (e.g. --prompt, chat, etc.).
    return ["-p", prompt];
  }

  protected attachStdio(
    child: ChildProcess,
    outputStream: WriteStream,
    lastMessagePath: string,
  ): (() => void) | undefined {
    // Tee stdout into both the combined log and the last-message file so the
    // reply can be quoted by status queries and notifications without parsing
    // the log.
    const lastMessageStream = createWriteStream(lastMessagePath, { flags: "w" });
    child.stdout?.on("data", (chunk) => {
      outputStream.write(chunk);
      lastMessageStream.write(chunk);
    });
    child.stderr?.pipe(outputStream);
    return () => lastMessageStream.end();
  }
}
