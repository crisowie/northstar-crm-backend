import assert from "node:assert/strict";
import test from "node:test";
import { BadRequestException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SmsService } from "../src/sms/sms.service";
import { TelnyxSmsProvider, type SmsProvider, type SmsReadiness } from "../src/sms/sms-provider";
import { WorkspaceService } from "../src/workspace/workspace.service";

class FakeSmsProvider implements SmsProvider {
  enabled = true;
  fail = false;
  sendCount = 0;

  readiness(): SmsReadiness {
    return {
      configured: this.enabled,
      status: this.enabled ? "ready" : "not_configured",
      message: "test readiness",
      missing: this.enabled ? [] : ["TELNYX_API_KEY"],
      senderNumber: this.enabled ? "+14155550100" : null,
    };
  }

  async send() {
    this.sendCount += 1;
    if (this.fail) throw new Error("provider failure");
    return { id: `provider-message-${this.sendCount}`, status: "queued" };
  }
}

function harness(provider = new FakeSmsProvider()) {
  const workspace = {
    async getWorkspace() {
      return {
        data: {
          contacts: [
            { id: "contact-1", phone: "+14155550199", archived: false },
            { id: "archived-contact", phone: "+14155550188", archived: true },
          ],
        },
      };
    },
  };
  const config = { get: () => undefined } as unknown as ConfigService;
  return {
    service: new SmsService(config, provider, workspace as unknown as WorkspaceService),
    provider,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    contactId: "contact-1",
    text: " Hello there ",
    consentConfirmed: true,
    idempotencyKey: "sms_request_0123456789",
    ...overrides,
  };
}

test("Telnyx SMS readiness reports missing sender and API configuration", () => {
  const provider = new TelnyxSmsProvider({ get: () => undefined } as unknown as ConfigService);
  const readiness = provider.readiness();
  assert.equal(readiness.configured, false);
  assert.equal(readiness.senderNumber, null);
  assert.ok(readiness.missing.includes("TELNYX_API_KEY"));
});

test("SMS sending requires explicit consent and an active CRM contact", async () => {
  const { service } = harness();
  await assert.rejects(service.sendMessage("user-a", request({ consentConfirmed: false })), BadRequestException);
  await assert.rejects(service.sendMessage("user-a", request({ contactId: "missing" })), NotFoundException);
  await assert.rejects(service.sendMessage("user-a", request({ contactId: "archived-contact" })), NotFoundException);
});

test("SMS sends use the CRM contact number, persist history, and are idempotent", async () => {
  const { service, provider } = harness();
  const first = await service.sendMessage("user-a", request());
  const duplicate = await service.sendMessage("user-a", request());
  assert.equal(first.message.destination, "+14155550199");
  assert.equal(first.message.body, "Hello there");
  assert.equal(first.message.senderNumber, "+14155550100");
  assert.equal(first.message.status, "queued");
  assert.equal("userId" in first.message, false);
  assert.equal("idempotencyKey" in first.message, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(provider.sendCount, 1);
  assert.equal((await service.listMessages("user-a")).messages.length, 1);
  assert.equal((await service.listMessages("user-b")).messages.length, 0);
});

test("concurrent requests with the same key create one SMS", async () => {
  const { service, provider } = harness();
  const results = await Promise.all([
    service.sendMessage("user-a", request()),
    service.sendMessage("user-a", request()),
  ]);
  assert.equal(provider.sendCount, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
});

test("unconfigured SMS is rejected without calling the provider", async () => {
  const provider = new FakeSmsProvider();
  provider.enabled = false;
  const { service } = harness(provider);
  await assert.rejects(service.sendMessage("user-a", request()), ServiceUnavailableException);
  assert.equal(provider.sendCount, 0);
});

test("provider failures are recorded and an idempotent retry does not send twice", async () => {
  const provider = new FakeSmsProvider();
  provider.fail = true;
  const { service } = harness(provider);
  await assert.rejects(service.sendMessage("user-a", request()), ServiceUnavailableException);
  const retry = await service.sendMessage("user-a", request());
  assert.equal(retry.duplicate, true);
  assert.equal(retry.message.status, "failed");
  assert.equal(provider.sendCount, 1);
});
