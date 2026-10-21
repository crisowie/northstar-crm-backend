import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { ExecutionContext, UnauthorizedException, ServiceUnavailableException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { LOCAL_DEMO_USER_ID, SupabaseAuthGuard } from "../src/workspace/supabase-auth.guard";
import { normalizeVoiceNumber } from "../src/voice/phone";
import { VoiceService } from "../src/voice/voice.service";
import { TelnyxVoiceProvider, type TelnyxVoiceEvent, type VoiceProvider, type VoiceReadiness } from "../src/voice/voice-provider";

class FakeProvider implements VoiceProvider {
  enabled = true;
  validSignature = true;
  failDial = false;
  dialCount = 0;
  deletedCredentials: string[] = [];
  bridges: [string, string][] = [];
  hangups: string[] = [];
  readiness(): VoiceReadiness {
    return {
      configured: this.enabled, status: this.enabled ? "ready" : "not_configured", message: "test readiness",
      missing: this.enabled ? [] : ["TELNYX_API_KEY"], callerIds: this.enabled ? { US: "+14155550100", GB: "+442079460000" } : {},
    };
  }
  callerId(country: "US" | "GB") { return this.enabled ? (country === "US" ? "+14155550100" : "+442079460000") : null; }
  sipConnectionId() { return "sip-connection-1"; }
  voiceApplicationId() { return "voice-application-1"; }
  webhookUrl() { return "https://api.example.test/api/voice/webhooks"; }
  async issueBrowserCredential() { return { credential: { id: "credential-1", username: "gencred-user", expiresAt: new Date(Date.now() + 60_000).toISOString() }, token: "jwt-browser-token-value" }; }
  async deleteBrowserCredential(credentialId: string) { this.deletedCredentials.push(credentialId); }
  async dialPstn() {
    this.dialCount += 1;
    if (this.failDial) throw new Error("provider unavailable");
    return { callControlId: "pstn-leg-1" };
  }
  async bridge(first: string, second: string) { this.bridges.push([first, second]); }
  async hangup(callControlId: string) { this.hangups.push(callControlId); }
  async verifyWebhook(rawBody: string): Promise<TelnyxVoiceEvent> {
    if (!this.validSignature) throw new Error("signature did not verify");
    return JSON.parse(rawBody) as TelnyxVoiceEvent;
  }
}

function harness(provider = new FakeProvider()) {
  let workspaceData: any = {
    organization: "Test", pipelineStages: [], jobStatuses: [], contacts: [{ id: "contact-1" }],
    companies: [], jobs: [], opportunities: [], tasks: [], notes: [], activities: [],
  };
  const workspace = {
    async getWorkspace() { return { data: structuredClone(workspaceData) }; },
    async saveWorkspace(_userId: string, body: any) { workspaceData = structuredClone(body.data); return { saved: true }; },
    get saved() { return workspaceData; },
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  return { service: new VoiceService(config, provider, workspace as any), provider, workspace };
}

function event(id: string, eventType: string, occurredAt: string, payload: Record<string, unknown>) {
  return JSON.stringify({ data: { id, event_type: eventType, occurred_at: occurredAt, payload } });
}

const signedHeaders = { "telnyx-signature-ed25519": "verified-by-provider-mock", "telnyx-timestamp": "test" };

async function createAuthorizedCall(service: VoiceService, userId = "user-a") {
  const session = await service.issueToken(userId);
  return service.authorizeCall(userId, {
    sessionId: session.sessionId, contactId: "contact-1", destination: "+14155550199",
    idempotencyKey: "idempotency_key_0123456789", callerId: "+442079460000",
  });
}

test("normalizes US and UK numbers and rejects unsupported regions", () => {
  assert.deepEqual(normalizeVoiceNumber("(415) 555-0199", "US"), { e164: "+14155550199", country: "US" });
  assert.deepEqual(normalizeVoiceNumber("020 7946 0958", "GB"), { e164: "+442079460958", country: "GB" });
  assert.throws(() => normalizeVoiceNumber("+33142685300"));
  assert.throws(() => normalizeVoiceNumber("not a phone number", "US"));
});

test("missing provider setup disables token issuance without crashing CRM", async () => {
  const provider = new FakeProvider(); provider.enabled = false;
  const { service } = harness(provider);
  assert.equal(service.getConfig().configured, false);
  await assert.rejects(service.issueToken("user-a"), ServiceUnavailableException);
});

test("token issuance is provider-backed and never returns SIP credentials", async () => {
  const { service } = harness();
  const token = await service.issueToken("user-a");
  assert.equal(token.token, "jwt-browser-token-value");
  assert.ok(token.sessionId);
  assert.equal("username" in token, false);
  assert.equal("credentialId" in token, false);
});

test("calling sessions are bound to their owner and revoked on request", async () => {
  const { service, provider } = harness();
  const session = await service.issueToken("user-a");
  await assert.rejects(service.revokeSession("user-b", session.sessionId), NotFoundException);
  assert.deepEqual(await service.revokeSession("user-a", session.sessionId), { revoked: true });
  assert.deepEqual(provider.deletedCredentials, ["credential-1"]);
  await assert.rejects(service.authorizeCall("user-a", {
    sessionId: session.sessionId, destination: "+14155550199", idempotencyKey: "another_idempotency_012345",
  }), UnauthorizedException);
});

test("server ignores caller ID input, validates call ownership, and selects configured caller ID", async () => {
  const { service } = harness();
  const call = await createAuthorizedCall(service);
  assert.equal(call.callerId, "+14155550100");
  assert.equal(call.destination, "+14155550199");
  assert.equal(call.status, "authorized");
  assert.deepEqual((await service.listCalls("user-b")).calls, []);
  await assert.rejects(service.endCall("user-b", call.id), NotFoundException);
});

test("call authorization rejects a missing country-specific caller ID", async () => {
  const provider = new FakeProvider();
  provider.callerId = () => null;
  const { service } = harness(provider);
  const session = await service.issueToken("user-a");
  await assert.rejects(service.authorizeCall("user-a", {
    sessionId: session.sessionId, destination: "+14155550199", idempotencyKey: "idempotency_key_0123456789",
  }), ServiceUnavailableException);
});

test("webhook signatures are verified before processing", async () => {
  const provider = new FakeProvider(); provider.validSignature = false;
  const { service } = harness(provider);
  await assert.rejects(service.processWebhook(event("event-1", "call.hangup", new Date().toISOString(), {}), signedHeaders), UnauthorizedException);
});

test("Telnyx provider verifies Ed25519 signatures against the unmodified body and timestamp", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const configValues: Record<string, string> = { TELNYX_API_KEY: "test-api-key", TELNYX_PUBLIC_KEY: publicKeyBytes.toString("base64") };
  const provider = new TelnyxVoiceProvider({ get: (name: string) => configValues[name] } as unknown as ConfigService);
  const body = event("ed25519-event", "call.hangup", new Date().toISOString(), {});
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64");
  const headers = { "telnyx-signature-ed25519": signature, "telnyx-timestamp": timestamp };
  assert.equal((await provider.verifyWebhook(body, headers)).data?.id, "ed25519-event");
  await assert.rejects(provider.verifyWebhook(`${body} `, headers));
});

test("signed call events are idempotent and determine lifecycle and duration", async () => {
  const { service, provider } = harness();
  const call = await createAuthorizedCall(service);
  const initiated = event("event-init-1", "call.initiated", "2026-10-21T10:00:00.000Z", {
    call_control_id: "webrtc-leg-1", connection_id: provider.sipConnectionId(), direction: "outgoing",
    state: "parked", from: call.callerId, to: call.destination,
    custom_headers: [{ header_name: "X-Northstar-Call-ID", header_value: call.id }],
  });
  await service.processWebhook(initiated, signedHeaders);
  const duplicate = await service.processWebhook(initiated, signedHeaders);
  assert.deepEqual(duplicate, { received: true, duplicate: true });
  assert.equal(provider.dialCount, 1);
  assert.equal((await service.getCallStatus("user-a", call.id)).call.status, "dialing");

  await service.processWebhook(event("event-pstn-init-1", "call.initiated", "2026-10-21T10:00:01.000Z", {
    call_control_id: "pstn-leg-1", connection_id: provider.voiceApplicationId(),
    client_state: Buffer.from(JSON.stringify(call.id)).toString("base64"), state: "initiated", from: call.callerId, to: call.destination,
  }), signedHeaders);
  assert.equal(provider.dialCount, 1);
  assert.deepEqual(provider.hangups, []);

  await service.processWebhook(event("event-answer-1", "call.answered", "2026-10-21T10:00:10.000Z", {
    call_control_id: "pstn-leg-1", connection_id: provider.voiceApplicationId(), client_state: Buffer.from(JSON.stringify(call.id)).toString("base64"),
  }), signedHeaders);
  assert.deepEqual(provider.bridges, [["webrtc-leg-1", "pstn-leg-1"]]);
  assert.equal((await service.getCallStatus("user-a", call.id)).call.status, "connected");

  await service.processWebhook(event("event-hangup-1", "call.hangup", "2026-10-21T10:00:40.000Z", {
    call_control_id: "pstn-leg-1", connection_id: provider.voiceApplicationId(), client_state: Buffer.from(JSON.stringify(call.id)).toString("base64"),
  }), signedHeaders);
  const ended = (await service.getCallStatus("user-a", call.id)).call;
  assert.equal(ended.status, "ended");
  assert.equal(ended.durationSeconds, 30);
  assert.equal(ended.answeredAt, "2026-10-21T10:00:10.000Z");
  assert.ok(provider.hangups.includes("webrtc-leg-1"));
});

test("provider dial failure is persisted and the browser leg is hung up", async () => {
  const provider = new FakeProvider(); provider.failDial = true;
  const { service } = harness(provider);
  const call = await createAuthorizedCall(service);
  await service.processWebhook(event("event-init-fail", "call.initiated", new Date().toISOString(), {
    call_control_id: "webrtc-failed-leg", connection_id: provider.sipConnectionId(), direction: "outgoing", state: "parked",
    from: call.callerId, to: call.destination,
    custom_headers: [{ header_name: "X-Northstar-Call-ID", header_value: call.id }],
  }), signedHeaders);
  const failed = (await service.getCallStatus("user-a", call.id)).call;
  assert.equal(failed.status, "failed");
  assert.match(failed.failureReason || "", /voice provider/);
  assert.ok(provider.hangups.includes("webrtc-failed-leg"));
});

test("outcomes upsert one timeline item and one follow-up task", async () => {
  const { service, provider, workspace } = harness();
  const call = await createAuthorizedCall(service);
  await service.processWebhook(event("event-init-outcome", "call.initiated", "2026-10-21T10:00:00.000Z", {
    call_control_id: "webrtc-outcome-leg", connection_id: provider.sipConnectionId(), direction: "outgoing", state: "parked",
    from: call.callerId, to: call.destination,
    custom_headers: [{ header_name: "X-Northstar-Call-ID", header_value: call.id }],
  }), signedHeaders);
  await service.processWebhook(event("event-hangup-outcome", "call.hangup", "2026-10-21T10:00:03.000Z", {
    call_control_id: "webrtc-outcome-leg", connection_id: provider.sipConnectionId(), custom_headers: [{ header_name: "X-Northstar-Call-ID", header_value: call.id }],
  }), signedHeaders);
  await service.saveOutcome("user-a", call.id, { outcome: "Connected — follow-up required", note: "Send the overview", followUpDate: "2026-10-23" });
  await service.saveOutcome("user-a", call.id, { outcome: "Connected — follow-up required", note: "Send the overview", followUpDate: "2026-10-23" });
  assert.equal(workspace.saved.activities.filter((item: any) => item.id === `voice-call-${call.id}`).length, 1);
  assert.equal(workspace.saved.tasks.filter((item: any) => item.id === `voice-follow-up-${call.id}`).length, 1);
});

test("local demo auth guard still rejects missing credentials and binds user to the demo identity", async () => {
  const config = { get: (key: string) => key === "NODE_ENV" ? "development" : key === "AUTH_MODE" ? "mock" : undefined } as unknown as ConfigService;
  const guard = new SupabaseAuthGuard(config);
  const request: any = { headers: { authorization: "Bearer northstar-local-demo-token" } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  assert.equal(await guard.canActivate(context), true);
  assert.equal(request.user.id, LOCAL_DEMO_USER_ID);
  const unauthenticated = { switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) } as unknown as ExecutionContext;
  await assert.rejects(guard.canActivate(unauthenticated), UnauthorizedException);
});
