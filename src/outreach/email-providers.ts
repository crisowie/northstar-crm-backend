import {
  SESv2Client,
  GetAccountCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { Resend } from "resend";

export type EmailProviderId = "gmail" | "ses" | "resend";

export type EmailProviderCapabilities = {
  sending: boolean;
  inboundSynchronization: boolean;
  webhooks: boolean;
  bounceReporting: boolean;
  deliveryEvents: boolean;
  openTracking: boolean;
  clickTracking: boolean;
};

export type ProviderConfiguration = {
  senderEmail: string;
  accessToken?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  apiKey?: string;
  region?: string;
  configurationSet?: string;
  webhookSecret?: string;
  webhookUrl?: string;
};

export type ProviderMessage = {
  id: string;
  recipient: string;
  subject: string;
  html: string;
  senderName: string;
  replyTo?: string;
};

export type ProviderSendResult = {
  providerMessageId: string;
  providerThreadId?: string;
  acceptedAt: string;
};

export type ProviderTestResult = {
  senderEmail?: string;
  verifiedDomainStatus?: string;
  sandbox?: boolean;
  eventTypes?: string[];
  webhookConfigured?: boolean;
  openTracking?: boolean;
  topicArns?: string[];
  snsSubscriptionConfirmedAt?: string;
};

const resendEventTypes: Record<string, string> = {
  "email.sent": "provider_accepted", "email.delivered": "delivered", "email.bounced": "bounced",
  "email.complained": "complaint", "email.failed": "failed", "email.opened": "opened", "email.clicked": "clicked",
};

const sesEventTypes: Record<string, string> = {
  Send: "provider_accepted", Delivery: "delivered", Bounce: "bounced", Complaint: "complaint",
  Reject: "failed", "Rendering Failure": "failed", Open: "opened", Click: "clicked",
};

export function normalizeResendEventType(type: string) { return resendEventTypes[type] || null; }
export function normalizeSesEventType(type: string) { return sesEventTypes[type] || null; }

export interface EmailProviderAdapter {
  readonly id: EmailProviderId;
  capabilities(config: ProviderConfiguration, health?: Partial<ProviderTestResult>): EmailProviderCapabilities;
  validate(config: ProviderConfiguration): string[];
  test(config: ProviderConfiguration): Promise<ProviderTestResult>;
  send(config: ProviderConfiguration, message: ProviderMessage): Promise<ProviderSendResult>;
}

const baseCapabilities = (patch: Partial<EmailProviderCapabilities>): EmailProviderCapabilities => ({
  sending: false,
  inboundSynchronization: false,
  webhooks: false,
  bounceReporting: false,
  deliveryEvents: false,
  openTracking: false,
  clickTracking: false,
  ...patch,
});

function required(config: ProviderConfiguration, fields: Array<keyof ProviderConfiguration>) {
  return fields.filter((key) => !String(config[key] || "").trim()).map((key) => String(key));
}

export class GmailEmailProvider implements EmailProviderAdapter {
  readonly id = "gmail" as const;

  capabilities() {
    return baseCapabilities({ sending: true, inboundSynchronization: true, clickTracking: true });
  }

  validate(config: ProviderConfiguration) {
    return required(config, ["senderEmail", "accessToken"]);
  }

  async test(config: ProviderConfiguration): Promise<ProviderTestResult> {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    const profile = await response.json().catch(() => ({})) as { emailAddress?: string };
    if (!response.ok || !profile.emailAddress) throw new Error("Gmail could not verify the connected mailbox.");
    return { senderEmail: profile.emailAddress, verifiedDomainStatus: "connected" };
  }

  async send(config: ProviderConfiguration, message: ProviderMessage): Promise<ProviderSendResult> {
    const rawMessage = [
      `From: ${message.senderName} <${config.senderEmail}>`,
      `To: <${message.recipient}>`,
      `Subject: =?UTF-8?B?${Buffer.from(message.subject, "utf8").toString("base64")}?=`,
      ...(message.replyTo ? [`Reply-To: <${message.replyTo}>`] : []),
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(message.html, "utf8").toString("base64"),
    ].join("\r\n");
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: Buffer.from(rawMessage, "utf8").toString("base64url") }),
    });
    const sent = await response.json().catch(() => ({})) as { id?: string; threadId?: string; error?: { message?: string } };
    if (!response.ok || !sent.id || !sent.threadId) {
      const error = new Error(sent.error?.message || "Gmail could not send this message.") as Error & { statusCode?: number };
      error.statusCode = response.status || undefined;
      throw error;
    }
    return { providerMessageId: sent.id, providerThreadId: sent.threadId, acceptedAt: new Date().toISOString() };
  }
}

export class SesEmailProvider implements EmailProviderAdapter {
  readonly id = "ses" as const;

  private client(config: ProviderConfiguration) {
    return new SESv2Client({
      region: config.region,
      ...(config.accessKeyId && config.secretAccessKey ? {
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      } : {}),
    });
  }

  capabilities(config: ProviderConfiguration, health?: Partial<ProviderTestResult>) {
    const eventTypes = new Set(health?.eventTypes || []);
    const confirmedWebhook = Boolean(config.configurationSet && health?.webhookConfigured && health.snsSubscriptionConfirmedAt);
    return baseCapabilities({
      sending: true,
      webhooks: confirmedWebhook,
      bounceReporting: confirmedWebhook && eventTypes.has("BOUNCE"),
      deliveryEvents: confirmedWebhook && eventTypes.has("DELIVERY"),
      openTracking: confirmedWebhook && Boolean(health?.openTracking),
      clickTracking: true,
    });
  }

  validate(config: ProviderConfiguration) {
    return required(config, ["senderEmail", "region", "accessKeyId", "secretAccessKey"]);
  }

  async test(config: ProviderConfiguration): Promise<ProviderTestResult> {
    const client = this.client(config);
    const [account, identity] = await Promise.all([
      client.send(new GetAccountCommand({})),
      client.send(new GetEmailIdentityCommand({ EmailIdentity: config.senderEmail })),
    ]);
    let eventTypes: string[] = [];
    let webhookConfigured = false;
    let openTracking = false;
    let topicArns: string[] = [];
    if (config.configurationSet) {
      const response = await client.send(new GetConfigurationSetEventDestinationsCommand({ ConfigurationSetName: config.configurationSet }));
      const snsDestinations = (response.EventDestinations || []).filter((destination) => destination.Enabled !== false && destination.SnsDestination?.TopicArn);
      eventTypes = [...new Set(snsDestinations.flatMap((destination) => destination.MatchingEventTypes || []).map(String))];
      webhookConfigured = snsDestinations.length > 0;
      openTracking = eventTypes.includes("OPEN");
      topicArns = [...new Set(snsDestinations.map((destination) => destination.SnsDestination?.TopicArn).filter((value): value is string => Boolean(value)))];
    }
    return {
      senderEmail: config.senderEmail,
      verifiedDomainStatus: identity.VerifiedForSendingStatus ? "verified" : "not verified",
      sandbox: !account.ProductionAccessEnabled,
      eventTypes,
      webhookConfigured,
      openTracking,
      topicArns,
    };
  }

  async send(config: ProviderConfiguration, message: ProviderMessage): Promise<ProviderSendResult> {
    const result = await this.client(config).send(new SendEmailCommand({
      FromEmailAddress: config.senderEmail,
      Destination: { ToAddresses: [message.recipient] },
      ...(message.replyTo ? { ReplyToAddresses: [message.replyTo] } : {}),
      ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
      EmailTags: [{ Name: "crmMessageId", Value: message.id }],
      Content: { Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: { Html: { Data: message.html, Charset: "UTF-8" } },
      } },
    }));
    if (!result.MessageId) throw new Error("Amazon SES accepted the request without returning a message identifier.");
    return { providerMessageId: result.MessageId, acceptedAt: new Date().toISOString() };
  }
}

export class ResendEmailProvider implements EmailProviderAdapter {
  readonly id = "resend" as const;

  private client(config: ProviderConfiguration) {
    return new Resend(config.apiKey);
  }

  capabilities(config: ProviderConfiguration, health?: Partial<ProviderTestResult>) {
    const events = new Set(health?.eventTypes || []);
    return baseCapabilities({
      sending: true,
      webhooks: Boolean(config.webhookSecret && health?.webhookConfigured),
      bounceReporting: events.has("email.bounced"),
      deliveryEvents: events.has("email.delivered"),
      openTracking: Boolean(health?.openTracking && events.has("email.opened")),
      clickTracking: true,
    });
  }

  validate(config: ProviderConfiguration) {
    return required(config, ["senderEmail", "apiKey"]);
  }

  async test(config: ProviderConfiguration): Promise<ProviderTestResult> {
    const client = this.client(config);
    const [domainResult, webhookResult] = await Promise.all([
      client.domains.list(),
      client.webhooks.list().catch(() => ({ data: null, error: null })),
    ]);
    if (domainResult.error || !domainResult.data) throw new Error("Resend could not list verified sending domains. Check the API key and its permissions.");
    const senderDomain = config.senderEmail.split("@")[1]?.toLowerCase();
    const domains = domainResult.data.data;
    const domain = domains.find((item) => String(item.name || "").toLowerCase() === senderDomain);
    const webhooks = (webhookResult.data as { data?: Array<Record<string, unknown>> } | null)?.data || [];
    const matchingWebhook = webhooks.find((item) => String(item.endpoint || "") === config.webhookUrl);
    const eventTypes = Array.isArray(matchingWebhook?.events) ? matchingWebhook.events.map(String) : [];
    return {
      senderEmail: config.senderEmail,
      verifiedDomainStatus: domain ? String(domain.status || "unknown") : "domain not found",
      eventTypes,
      webhookConfigured: Boolean(matchingWebhook && config.webhookSecret),
      openTracking: Boolean(domain && domain.open_tracking === true),
    };
  }

  async send(config: ProviderConfiguration, message: ProviderMessage): Promise<ProviderSendResult> {
    const response = await this.client(config).emails.send({
      from: config.senderEmail,
      to: message.recipient,
      subject: message.subject,
      html: message.html,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      headers: { "X-CRM-Message-ID": message.id },
      tags: [{ name: "crmMessageId", value: message.id }],
    }, { idempotencyKey: message.id });
    if (response.error || !response.data?.id) {
      const error = new Error(response.error?.message || "Resend could not send this message.") as Error & { statusCode?: number };
      error.statusCode = response.error?.statusCode ?? undefined;
      throw error;
    }
    return { providerMessageId: response.data.id, acceptedAt: new Date().toISOString() };
  }
}

export const emailProviders: Record<EmailProviderId, EmailProviderAdapter> = {
  gmail: new GmailEmailProvider(),
  ses: new SesEmailProvider(),
  resend: new ResendEmailProvider(),
};
