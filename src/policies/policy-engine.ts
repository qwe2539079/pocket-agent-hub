import type { PersonaKind, PolicyKind } from "../config/types.js";

export interface PolicyInput {
  persona: PersonaKind;
  policy: PolicyKind;
  text: string;
}

const blockedShellTerms = ["rm -rf", "mkfs", "shutdown", "reboot"];

export class PolicyEngine {
  assertAllowed(input: PolicyInput): void {
    switch (input.policy) {
      case "safe-chat":
        this.assertSafeChat(input.text);
        return;
      case "guarded-dev":
        this.assertGuardedDev(input.text);
        return;
      default: {
        const unknownPolicy: never = input.policy;
        throw new Error(`Unknown policy: ${unknownPolicy}`);
      }
    }
  }

  private assertSafeChat(text: string): void {
    if (text.includes("/shell")) {
      throw new Error("The safe-chat policy does not allow shell-style commands.");
    }
  }

  private assertGuardedDev(text: string): void {
    const normalized = text.toLowerCase();
    for (const term of blockedShellTerms) {
      if (normalized.includes(term)) {
        throw new Error(`Blocked high-risk command pattern: ${term}`);
      }
    }
  }
}
