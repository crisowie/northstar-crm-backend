import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { BadRequestException, ConflictException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { emailProviders } from "../src/outreach/email-providers";
import { OutreachService } from "../src/outreach/outreach.service";

const userId = "00000000-0000-4000-8000-000000000123";
const contact = {
  id: "contact-1", firstName: "Jamie", lastName: "Client", email: "jamie@example.test",
  companyId: "company-1", archived: false,
};

function createService(values: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    EMAIL_PROVIDER: "gmail",
    PUBLIC_API_URL: "http://localhost:5000/api",
    ...values,
  };
  const config = { get: (key: string) => env[key] };
  const workspace = { getWorkspace: async () => ({ data: { contacts: [contact], companies: [{ id: "company-1", name: "Client Co" }], opportunities: [] } }) };
  const service = new OutreachService(config as never, workspace as never);
  const state = service as unknown as {
    encrypt(value: string): string;
    volatileAccounts: Map<string, Record<string, unknown>>;
    volatileProviderConfigs: Map<string, Record<string, unknown>>;
    volatileProviderPreferences: Map<string, { provider: string; paused: boolean }>;
    volatileSuppressions: Map<string, Record<string, unknown>>;
    volatileMessages: Map<string, Array<Record<string, unknown>>>;
    volatileCalendarSecrets: Map<string, string>;
    volatileMeetings: Map<string, Array<Record<string, unknown>>>;
  };
  state.volatileAccounts.set(userId, {
    user_id: userId,
    email_address: "sender@example.test",
    refresh_token_encrypted: state.encrypt("refresh-token"),
    access_token_encrypted: state.encrypt("test-access-token"),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    history_id: "100",
  });
  return { service, state };
}

function sendInput(idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return {
    idempotencyKey, contactId: contact.id, subject: "A proposal for {{company}}",
    body: "Hi {{firstName}},\n\nLet us discuss a proposal.", senderName: "Taylor", ...extra,
  };
}

test("Gmail regression: an accepted Gmail send is stored with legacy and provider IDs, and idempotent retries do not resend", async () => {
  const { service } = createService();
  const originalSend = emailProviders.gmail.send;
  let sends = 0;
  emailProviders.gmail.send = async () => {
    sends += 1;
    return { providerMessageId: "gmail-message-1", providerThreadId: "gmail-thread-1", acceptedAt: new Date().toISOString() };
  };
  const key = randomUUID();
  try {
    const first = await service.sendMessage(userId, sendInput(key)) as Record<string, unknown>;
    const retry = await service.sendMessage(userId, sendInput(key)) as Record<string, unknown>;
    assert.equal(sends, 1);
    assert.equal(first.provider, "gmail");
    assert.equal(first.providerMessageId, "gmail-message-1");
    assert.equal(first.gmailThreadUrl, "https://mail.google.com/mail/u/0/#all/gmail-thread-1");
    assert.equal(retry.id, first.id);
    assert.equal(first.status, "sent");
  } finally {
    emailProviders.gmail.send = originalSend;
  }
});

test("Gmail regression: reply sync reads Gmail metadata and correlates by sender/time without message bodies", async () => {
  const { service, state } = createService();
  const row = {
    id: randomUUID(), idempotency_key: randomUUID(), user_id: userId, contact_id: contact.id, opportunity_id: null,
    recipient: contact.email, recipient_name: "Jamie Client", subject: "A proposal", body: "tracked body",
    status: "sent", sent_at: new Date(Date.now() - 60_000).toISOString(), replied_at: null,
    gmail_message_id: "gmail-message-2", gmail_thread_id: "gmail-thread-2", provider: "gmail",
    sender_account: "sender@example.test", provider_message_id: "gmail-message-2", provider_thread_id: "gmail-thread-2",
    provider_capabilities: emailProviders.gmail.capabilities({ senderEmail: "sender@example.test" }), recipient_opted_in: false,
    click_count: 0, created_at: new Date().toISOString(),
  };
  state.volatileMessages.set(userId, [row]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/threads\/gmail-thread-2\?format=metadata/);
    return Response.json({ messages: [
      { internalDate: String(Date.now() - 30_000), payload: { headers: [{ name: "From", value: "Jamie Client <jamie@example.test>" }] } },
    ] });
  };
  try {
    const result = await service.syncReplies(userId);
    assert.equal(result.replies, 1);
    assert.equal(row.status, "replied");
    assert.ok(row.replied_at);
    assert.equal(row.body, "tracked body");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gmail thread view loads full message bodies only after read-only authorization", async () => {
  const { service, state } = createService();
  const messageId = randomUUID();
  state.volatileMessages.set(userId, [{
    id: messageId, user_id: userId, contact_id: contact.id, opportunity_id: null,
    recipient: contact.email, recipient_name: "Jamie Client", subject: "A proposal", body: "Stored sent body",
    status: "replied", sent_at: new Date().toISOString(), replied_at: null,
    gmail_message_id: "gmail-message-thread", gmail_thread_id: "gmail-thread-full", provider: "gmail",
    sender_account: "sender@example.test", provider_message_id: "gmail-message-thread", provider_thread_id: "gmail-thread-full",
    provider_capabilities: emailProviders.gmail.capabilities({ senderEmail: "sender@example.test" }),
    idempotency_key: messageId, recipient_opted_in: false, click_count: 0, created_at: new Date().toISOString(),
  }]);
  state.volatileAccounts.set(userId, {
    user_id: userId, email_address: "sender@example.test",
    refresh_token_encrypted: state.encrypt("refresh-token"),
    access_token_encrypted: state.encrypt("test-access-token"),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    history_id: "100",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /threads\/gmail-thread-full\?format=full/);
    assert.match(String((init?.headers as Record<string, string>).Authorization), /test-access-token/);
    return Response.json({ messages: [{
      id: "reply-1", internalDate: String(Date.now()),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "Jamie Client <jamie@example.test>" },
          { name: "To", value: "sender@example.test" },
          { name: "Subject", value: "Re: A proposal" },
        ],
        body: { data: Buffer.from("Thanks, let's talk.").toString("base64url") },
      },
    }] });
  };
  try {
    const result = await service.getMessageThread(userId, messageId);
    assert.equal(result.source, "gmail");
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].direction, "received");
    assert.equal(result.messages[0].body, "Thanks, let's talk.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider failures with an explicit HTTP status are recorded as failed and are not retried with the same key", async () => {
  const { service, state } = createService();
  const originalSend = emailProviders.gmail.send;
  let sends = 0;
  emailProviders.gmail.send = async () => {
    sends += 1;
    throw Object.assign(new Error("Gmail quota exceeded"), { statusCode: 429 });
  };
  const key = randomUUID();
  try {
    await assert.rejects(service.sendMessage(userId, sendInput(key)), /rejected the email/);
    const rows = state.volatileMessages.get(userId) || [];
    assert.equal(rows[0].status, "failed");
    await assert.rejects(service.sendMessage(userId, sendInput(key)), ConflictException);
    assert.equal(sends, 1);
  } finally {
    emailProviders.gmail.send = originalSend;
  }
});

test("ambiguous network failures remain unresolved and block duplicate attempts", async () => {
  const { service, state } = createService();
  const originalSend = emailProviders.gmail.send;
  let sends = 0;
  emailProviders.gmail.send = async () => { sends += 1; throw new Error("socket timed out"); };
  const key = randomUUID();
  try {
    await assert.rejects(service.sendMessage(userId, sendInput(key)), ServiceUnavailableException);
    assert.equal((state.volatileMessages.get(userId) || [])[0].status, "sending");
    await assert.rejects(service.sendMessage(userId, sendInput(key)), ConflictException);
    await assert.rejects(service.sendMessage(userId, sendInput(randomUUID())), ConflictException);
    assert.equal(sends, 1);
  } finally {
    emailProviders.gmail.send = originalSend;
  }
});

test("workspace pause and suppression are checked before any provider call", async () => {
  const { service, state } = createService();
  const originalSend = emailProviders.gmail.send;
  let sends = 0;
  emailProviders.gmail.send = async () => { sends += 1; return { providerMessageId: "x", providerThreadId: "y", acceptedAt: new Date().toISOString() }; };
  try {
    state.volatileProviderPreferences.set(userId, { provider: "gmail", paused: true });
    await assert.rejects(service.sendMessage(userId, sendInput(randomUUID())), ConflictException);
    state.volatileProviderPreferences.set(userId, { provider: "gmail", paused: false });
    state.volatileSuppressions.set(`${userId}:${contact.email}`, { user_id: userId, email_address: contact.email, reason: "hard_bounce" });
    await assert.rejects(service.sendMessage(userId, sendInput(randomUUID())), ConflictException);
    assert.equal(sends, 0);
  } finally {
    emailProviders.gmail.send = originalSend;
  }
});

test("Resend cold-prospecting guard requires explicit opt-in before calling the delivery API", async () => {
  const { service, state } = createService({ EMAIL_PROVIDER: "resend" });
  state.volatileProviderPreferences.set(userId, { provider: "resend", paused: false });
  state.volatileProviderConfigs.set(`${userId}:resend`, {
    user_id: userId, provider: "resend",
    configuration_encrypted: state.encrypt(JSON.stringify({ senderEmail: "sender@example.test", apiKey: "test-resend-key" })),
    sender_email: "sender@example.test", is_active: true,
    health: { senderEmail: "sender@example.test", verifiedDomainStatus: "verified" },
    last_success_at: null, last_error: null,
  });
  const originalSend = emailProviders.resend.send;
  let sends = 0;
  emailProviders.resend.send = async () => { sends += 1; return { providerMessageId: "resend-id", acceptedAt: new Date().toISOString() }; };
  try {
    await assert.rejects(service.sendMessage(userId, sendInput(randomUUID(), { provider: "resend" })), BadRequestException);
    assert.equal(sends, 0);
    assert.deepEqual(state.volatileMessages.get(userId) || [], []);
  } finally {
    emailProviders.resend.send = originalSend;
  }
});

test("Resend webhook signatures are verified and duplicate event IDs are processed once", async () => {
  const { service, state } = createService();
  const messageId = randomUUID();
  const webhookSecret = `whsec_${Buffer.from("webhook-test-secret").toString("base64")}`;
  state.volatileProviderConfigs.set(`${userId}:resend`, {
    user_id: userId, provider: "resend",
    configuration_encrypted: state.encrypt(JSON.stringify({ senderEmail: "sender@example.test", apiKey: "test-resend-key", webhookSecret })),
    sender_email: "sender@example.test", is_active: true,
    health: { senderEmail: "sender@example.test", verifiedDomainStatus: "verified" },
    last_success_at: null, last_error: null,
  });
  const row = {
    id: messageId, idempotency_key: messageId, user_id: userId, contact_id: contact.id, opportunity_id: null,
    recipient: contact.email, recipient_name: "Jamie Client", subject: "A proposal", body: "tracked body",
    status: "accepted", sent_at: new Date().toISOString(), replied_at: null,
    gmail_message_id: null, gmail_thread_id: null, provider: "resend", sender_account: "sender@example.test",
    provider_message_id: "resend-message-1", provider_thread_id: null,
    provider_capabilities: emailProviders.resend.capabilities({ senderEmail: "sender@example.test", apiKey: "test-resend-key" }),
    recipient_opted_in: true, click_count: 0, created_at: new Date().toISOString(),
  };
  state.volatileMessages.set(userId, [row]);
  const rawBody = JSON.stringify({
    type: "email.delivered", created_at: new Date().toISOString(),
    data: { email_id: "resend-message-1", tags: { crmMessageId: messageId }, to: [contact.email] },
  });
  const id = "msg_test_1";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  const headers = { id, timestamp, signature: `v1,${signature}` };
  await assert.rejects(service.processResendWebhook(userId, rawBody, { ...headers, signature: "v1,bad-signature" }), UnauthorizedException);
  await service.processResendWebhook(userId, rawBody, headers);
  await service.processResendWebhook(userId, rawBody, headers);
  assert.equal((state.volatileMessages.get(userId) || [])[0].status, "delivered");
  assert.equal(state.volatileEvents.filter((event) => event.provider_event_id === id).length, 1);
});

test("Cal.com bookings require valid signatures, link contacts, and preserve reschedule and cancellation history", async () => {
  const { service, state } = createService();
  const secret = "a-cal-webhook-secret-with-at-least-32-characters";
  await service.saveCalendarWebhookSecret(userId, { secret });
  const booking = {
    triggerEvent: "BOOKING_CREATED",
    createdAt: new Date().toISOString(),
    payload: {
      uid: "cal-booking-1",
      title: "30 minute meeting",
      startTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
      attendees: [{ email: contact.email, name: "Jamie Client" }],
      location: "https://meet.example.test/room",
    },
  };
  const rawBody = JSON.stringify(booking);
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
  await assert.rejects(service.processCalWebhook(userId, rawBody, "bad-signature"), UnauthorizedException);
  await service.processCalWebhook(userId, rawBody, signature);
  let meetings = await service.getMeetings(userId);
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].contactId, contact.id);
  assert.equal(meetings[0].attendeeEmail, contact.email);
  assert.equal(meetings[0].status, "booked");

  const rescheduled = {
    ...booking,
    triggerEvent: "BOOKING_RESCHEDULED",
    payload: {
      ...booking.payload,
      uid: "cal-booking-2",
      rescheduleUid: "cal-booking-1",
      startTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      endTime: new Date(Date.now() + 150 * 60 * 1000).toISOString(),
    },
  };
  const rescheduledBody = JSON.stringify(rescheduled);
  await service.processCalWebhook(userId, rescheduledBody, createHmac("sha256", secret).update(rescheduledBody).digest("hex"));
  meetings = await service.getMeetings(userId);
  assert.equal(meetings.find((meeting) => meeting.id === "cal-booking-1")?.status, "rescheduled");
  assert.equal(meetings.find((meeting) => meeting.id === "cal-booking-2")?.status, "booked");

  const cancelled = { ...rescheduled, triggerEvent: "BOOKING_CANCELLED" };
  const cancelledBody = JSON.stringify(cancelled);
  await service.processCalWebhook(userId, cancelledBody, createHmac("sha256", secret).update(cancelledBody).digest("hex"));
  meetings = await service.getMeetings(userId);
  assert.equal(meetings.find((meeting) => meeting.id === "cal-booking-2")?.status, "cancelled");
  assert.equal(meetings.find((meeting) => meeting.id === "cal-booking-2")?.contactId, contact.id);
});

test("provider migration is additive and preserves existing message and tracking tables", () => {
  const migration = readFileSync(new URL("../supabase/migrations/004_email_providers.sql", import.meta.url), "utf8");
  assert.match(migration, /alter table public\.crm_outreach_messages\s+add column if not exists provider/is);
  assert.match(migration, /create table if not exists public\.crm_email_events/is);
  assert.match(migration, /create or replace function public\.record_outreach_click/is);
  assert.doesNotMatch(migration, /\bdrop\s+table\b|\btruncate\b|\bdrop\s+schema\b/i);
  const calendarMigration = readFileSync(new URL("../supabase/migrations/005_cal_bookings.sql", import.meta.url), "utf8");
  assert.match(calendarMigration, /create table if not exists public\.crm_calendar_bookings/is);
  assert.match(calendarMigration, /create table if not exists public\.crm_cal_webhook_configs/is);
});
