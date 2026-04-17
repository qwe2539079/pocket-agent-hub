import test from "node:test";
import assert from "node:assert/strict";

import {
  assertVerificationToken,
  buildHubMessage,
  isChallengeEvent,
  parseFeishuMessage,
  renderFeishuReply,
} from "../src/channels/feishu/protocol.js";

test("challenge events are detected", () => {
  assert.equal(isChallengeEvent({ challenge: "abc" }), true);
  assert.equal(isChallengeEvent({}), false);
});

test("verification token is enforced when configured", () => {
  assert.doesNotThrow(() => assertVerificationToken({ token: "ok" }, "ok"));
  assert.throws(() => assertVerificationToken({ token: "bad" }, "ok"));
});

test("Feishu text event is converted into a hub message with commands", () => {
  const parsed = parseFeishuMessage({
    header: {
      event_id: "evt-1",
      event_type: "im.message.receive_v1",
      create_time: "1713200000000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_test",
        },
      },
      message: {
        message_id: "om_1",
        chat_id: "oc_1",
        message_type: "text",
        content: JSON.stringify({ text: "/dev /codex /project soms investigate failing tests" }),
        create_time: "1713200000000",
      },
    },
  });

  assert.ok(parsed);
  const message = buildHubMessage(parsed!);

  assert.equal(message.channel, "feishu");
  assert.equal(message.senderId, "ou_test");
  assert.equal(message.conversationId, "oc_1");
  assert.equal(message.persona, "dev-control");
  assert.equal(message.targetAgent, "codex");
  assert.equal(message.projectId, "soms");
  assert.equal(message.text, "investigate failing tests");
});

test("Feishu reply text includes session id and approval note", () => {
  const reply = renderFeishuReply({
    sessionId: "claude:user-1",
    text: "done",
    requiresApproval: true,
  });

  assert.match(reply, /Session: claude:user-1/);
  assert.match(reply, /Approval required/);
});


test("Feishu text event supports explicit session commands", () => {
  const parsed = parseFeishuMessage({
    header: {
      event_id: "evt-2",
      event_type: "im.message.receive_v1",
      create_time: "1713200000000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_test",
        },
      },
      message: {
        message_id: "om_2",
        chat_id: "oc_2",
        message_type: "text",
        content: JSON.stringify({ text: "/dev /codex /project soms /current" }),
        create_time: "1713200000000",
      },
    },
  });

  assert.ok(parsed);
  const message = buildHubMessage(parsed);

  assert.equal(message.sessionCommand, "show-current-session");
  assert.equal(message.hasDirectives, true);
});

function buildFromText(text: string, eventId = "evt-x", chatId = "oc-x") {
  const parsed = parseFeishuMessage({
    header: {
      event_id: eventId,
      event_type: "im.message.receive_v1",
      create_time: "1713200000000",
    },
    event: {
      sender: { sender_id: { open_id: "ou_test" } },
      message: {
        message_id: eventId,
        chat_id: chatId,
        message_type: "text",
        content: JSON.stringify({ text }),
        create_time: "1713200000000",
      },
    },
  });
  assert.ok(parsed);
  return buildHubMessage(parsed);
}

test("Feishu text event parses /list and /running as session commands", () => {
  const list = buildFromText("/list");
  assert.equal(list.sessionCommand, "list-runs");
  assert.equal(list.hasDirectives, true);
  assert.equal(list.resumeRunId, undefined);

  const running = buildFromText("/codex /running");
  assert.equal(running.sessionCommand, "show-running");
  assert.equal(running.targetAgent, "codex");
  assert.equal(running.hasDirectives, true);
});

test("Feishu text event parses /resume with and without a run id", () => {
  const withId = buildFromText("/resume 1713200000000");
  assert.equal(withId.sessionCommand, "resume-run");
  assert.equal(withId.resumeRunId, "1713200000000");
  assert.equal(withId.hasDirectives, true);

  const missingId = buildFromText("/resume");
  assert.equal(missingId.sessionCommand, "resume-run");
  assert.equal(missingId.resumeRunId, undefined);

  const directiveAfter = buildFromText("/resume /codex");
  assert.equal(directiveAfter.sessionCommand, "resume-run");
  assert.equal(directiveAfter.resumeRunId, undefined);
  assert.equal(directiveAfter.targetAgent, "codex");
});
