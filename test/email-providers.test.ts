import assert from "node:assert/strict";
import test from "node:test";
import {
  emailProviders,
  normalizeResendEventType,
  normalizeSesEventType,
} from "../src/outreach/email-providers";

test("Gmail adapter keeps sending through the Gmail API and returns provider IDs", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";
  let requestBody = "";
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-access-token");
    requestBody = String(init?.body || "");
    return Response.json({ id: "gmail-message-123", threadId: "gmail-thread-456" });
  };
  try {
    const result = await emailProviders.gmail.send({ senderEmail: "sender@example.test", accessToken: "test-access-token" }, {
      id: "00000000-0000-4000-8000-000000000001",
      recipient: "client@example.test",
      subject: "A tailored proposal",
      html: "<div>Hello client</div>",
      senderName: "Northstar",
    });
    assert.equal(requestUrl, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    const raw = JSON.parse(requestBody).raw as string;
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    assert.match(decoded, /From: Northstar <sender@example\.test>/);
    assert.match(decoded, /To: <client@example\.test>/);
    assert.equal(result.providerMessageId, "gmail-message-123");
    assert.equal(result.providerThreadId, "gmail-thread-456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider capabilities only advertise mailbox and event support each adapter provides", () => {
  const gmail = emailProviders.gmail.capabilities({ senderEmail: "sender@example.test" });
  assert.equal(gmail.sending, true);
  assert.equal(gmail.inboundSynchronization, true);
  assert.equal(gmail.deliveryEvents, false);
  assert.equal(gmail.openTracking, false);

  const ses = emailProviders.ses.capabilities({ senderEmail: "sender@example.test", configurationSet: "crm-events" }, {
    senderEmail: "sender@example.test", eventTypes: ["DELIVERY", "BOUNCE"], webhookConfigured: true,
  });
  assert.equal(ses.inboundSynchronization, false);
  assert.equal(ses.deliveryEvents, false, "SNS event delivery is not confirmed until SNS completes subscription confirmation");
  assert.equal(ses.bounceReporting, false);

  const confirmedSes = emailProviders.ses.capabilities({ senderEmail: "sender@example.test", configurationSet: "crm-events" }, {
    senderEmail: "sender@example.test", eventTypes: ["DELIVERY", "BOUNCE"], webhookConfigured: true,
    snsSubscriptionConfirmedAt: new Date().toISOString(),
  });
  assert.equal(confirmedSes.deliveryEvents, true);
  assert.equal(confirmedSes.bounceReporting, true);

  const resend = emailProviders.resend.capabilities({ senderEmail: "sender@example.test", apiKey: "key", webhookSecret: "secret" }, {
    senderEmail: "sender@example.test", webhookConfigured: true, eventTypes: ["email.delivered"],
  });
  assert.equal(resend.inboundSynchronization, false);
  assert.equal(resend.deliveryEvents, true);
  assert.equal(resend.bounceReporting, false);
  assert.equal(resend.openTracking, false);
});

test("provider validation reports only missing field names", () => {
  assert.deepEqual(emailProviders.ses.validate({ senderEmail: "" }), ["senderEmail", "region", "accessKeyId", "secretAccessKey"]);
  assert.deepEqual(emailProviders.resend.validate({ senderEmail: "sender@example.test" }), ["apiKey"]);
  assert.deepEqual(emailProviders.gmail.validate({ senderEmail: "sender@example.test" }), ["accessToken"]);
});

test("provider event normalization is explicit and ignores events without a mapped capability", () => {
  assert.equal(normalizeSesEventType("Delivery"), "delivered");
  assert.equal(normalizeSesEventType("Bounce"), "bounced");
  assert.equal(normalizeSesEventType("DeliveryDelay"), null);
  assert.equal(normalizeResendEventType("email.opened"), "opened");
  assert.equal(normalizeResendEventType("email.received"), null);
});
