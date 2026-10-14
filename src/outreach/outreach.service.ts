import { createCipheriv, createDecipheriv, createHmac, createVerify, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ConfirmSubscriptionCommand, SNSClient } from "@aws-sdk/client-sns";
import { Resend } from "resend";
import { WorkspaceService } from "../workspace/workspace.service";
import { emailProviders, EmailProviderCapabilities, EmailProviderId, ProviderConfiguration, ProviderTestResult, normalizeResendEventType, normalizeSesEventType } from "./email-providers";

type StoredAccount = {
  user_id: string;
  email_address: string;
  refresh_token_encrypted: string;
  access_token_encrypted: string;
  access_token_expires_at: string | null;
  history_id?: string | null;
  last_success_at?: string | null;
  last_error?: string | null;
};
type ProviderConfigRow = {
  user_id: string;
  provider: "ses" | "resend";
  configuration_encrypted: string;
  configuration_source?: "workspace" | "environment";
  sender_email: string;
  is_active: boolean;
  health: Partial<ProviderTestResult>;
  last_success_at: string | null;
  last_error: string | null;
};
type StoredEmailEvent = {
  user_id: string;
  message_id: string | null;
  provider: EmailProviderId;
  provider_message_id: string | null;
  sender_account: string | null;
  event_type: string;
  event_timestamp: string;
  provider_event_id: string;
  details: Record<string, unknown>;
  processing_status: "received" | "processed" | "ignored" | "failed";
  event_source: string;
};
type MessageRow = {
  id: string;
  user_id: string;
  contact_id: string;
  opportunity_id: string | null;
  recipient: string;
  recipient_name: string;
  subject: string;
  body: string;
  status: "sending" | "sent" | "accepted" | "delivered" | "bounced" | "complained" | "replied" | "failed";
  sent_at: string | null;
  replied_at: string | null;
  gmail_message_id: string | null;
  gmail_thread_id: string | null;
  provider: EmailProviderId;
  sender_account: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  provider_capabilities: EmailProviderCapabilities;
  idempotency_key: string;
  recipient_opted_in: boolean;
  click_count: number;
  created_at?: string;
};
type ClickLink = { token: string; user_id: string; message_id: string; target_url: string; click_count: number };
type OAuthTokens = { access_token: string; expires_in?: number; refresh_token?: string; error?: string; error_description?: string };
type GmailMessage = { internalDate?: string; payload?: { headers?: { name?: string; value?: string }[] } };
type GmailHistoryItem = { messagesAdded?: Array<{ message?: { id?: string; threadId?: string } }> };
type CalendarMeetingRow = {
  user_id: string;
  cal_uid: string;
  contact_id: string | null;
  title: string;
  attendee_name: string;
  attendee_email: string;
  start_time: string;
  end_time: string;
  location: string | null;
  status: "booked" | "cancelled" | "rescheduled";
  created_at: string;
  updated_at: string;
};
type GroqSettingsRow = {
  user_id: string;
  api_key_encrypted: string | null;
  model: string;
  last_tested_at: string | null;
  last_error: string | null;
};

const providerIds: EmailProviderId[] = ["gmail", "ses", "resend"];
const eventTypes = new Set(["queued", "sending", "sent", "provider_accepted", "delivered", "bounced", "complaint", "failed", "opened", "clicked", "reply_received", "unsubscribed"]);
const outreachMessageColumns = "id,user_id,contact_id,opportunity_id,recipient,recipient_name,subject,body,status,sent_at,replied_at,gmail_message_id,gmail_thread_id,provider,sender_account,provider_message_id,provider_thread_id,provider_capabilities,idempotency_key,recipient_opted_in,click_count,created_at";

function providerId(value: unknown): EmailProviderId {
  if (typeof value === "string" && providerIds.includes(value as EmailProviderId)) return value as EmailProviderId;
  throw new BadRequestException("Choose Gmail, Amazon SES, or Resend as the email provider.");
}

function normalizedSubject(value: string) {
  return value.trim().replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").replace(/\s+/g, " ").toLowerCase();
}

function headersOf(message: GmailMessage) {
  const headers = message.payload?.headers || [];
  const get = (name: string) => headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || "";
  return { from: get("From"), to: get("To"), subject: get("Subject") };
}

function addressOf(value: string) {
  return (value.match(/<([^>]+)>/)?.[1] || value).trim().toLowerCase();
}

function statusCodeOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { statusCode?: unknown; $metadata?: { httpStatusCode?: unknown } };
  const code = Number(value.statusCode ?? value.$metadata?.httpStatusCode);
  return Number.isFinite(code) && code >= 100 && code <= 599 ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function mergeFields(value: string, fields: Record<string, string>) {
  return value.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, key: string) => fields[key] ?? "");
}

@Injectable()
export class OutreachService {
  private readonly storage: SupabaseClient | null;
  private readonly volatileAccounts = new Map<string, StoredAccount>();
  private readonly volatileMessages = new Map<string, MessageRow[]>();
  private readonly volatileLinks = new Map<string, ClickLink>();
  private readonly volatileProviderConfigs = new Map<string, ProviderConfigRow>();
  private readonly volatileProviderPreferences = new Map<string, { provider: EmailProviderId; paused: boolean }>();
  private readonly volatileSuppressions = new Map<string, { user_id: string; email_address: string; reason: string; provider: EmailProviderId; created_at: string; source_event_id: string | null }>();
  private readonly volatileEvents: StoredEmailEvent[] = [];
  private readonly volatileCalendarSecrets = new Map<string, string>();
  private readonly volatileMeetings = new Map<string, CalendarMeetingRow[]>();
  private readonly volatileGroqSettings = new Map<string, GroqSettingsRow>();

  constructor(@Inject(ConfigService) private readonly config: ConfigService, @Inject(WorkspaceService) private readonly workspaceService: WorkspaceService) {
    const url = config.get<string>("SUPABASE_URL")?.trim();
    const serviceRoleKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    if (Boolean(url) !== Boolean(serviceRoleKey)) throw new Error("Set both Supabase service variables, or leave both empty for local development.");
    this.storage = url && serviceRoleKey ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  }

  private safeProviderError(error: unknown, config: ProviderConfiguration = { senderEmail: "" }) {
    let message = error instanceof Error ? error.message : "The provider operation failed.";
    for (const secret of [config.accessKeyId, config.secretAccessKey, config.apiKey, config.webhookSecret, config.accessToken]) {
      if (secret && secret.length >= 4) message = message.split(secret).join("[redacted]");
    }
    return message.slice(0, 500);
  }

  private get publicApiBase() {
    const configured = this.config.get<string>("PUBLIC_API_URL")?.trim();
    if (!configured) throw new ServiceUnavailableException("Set PUBLIC_API_URL to the reachable API base URL, including /api, before connecting Gmail.");
    let url: URL;
    try { url = new URL(configured); } catch { throw new ServiceUnavailableException("PUBLIC_API_URL must be a valid API URL including /api."); }
    const isProduction = (this.config.get<string>("NODE_ENV") || process.env.NODE_ENV) === "production";
    if (!['http:', 'https:'].includes(url.protocol) || (isProduction && url.protocol !== "https:")) throw new ServiceUnavailableException("PUBLIC_API_URL must use HTTPS in production.");
    if (!url.pathname.replace(/\/+$/, "").endsWith("/api")) throw new ServiceUnavailableException("PUBLIC_API_URL must include the /api path.");
    return configured.replace(/\/+$/, "");
  }

  private get redirectUri() {
    return this.publicApiBase + "/outreach/gmail/callback";
  }

  frontendResultUrl(result: "connected" | "error") {
    const origin = (this.config.get<string>("FRONTEND_ORIGIN") || "http://localhost:5173").split(",")[0].trim();
    const url = new URL("/", origin);
    url.searchParams.set("gmail", result);
    return url.toString();
  }

  private googleClientId() {
    const value = this.config.get<string>("GOOGLE_CLIENT_ID")?.trim();
    if (!value) throw new ServiceUnavailableException("Gmail is not configured. Add the Google OAuth client settings to the API environment.");
    return value;
  }

  private googleClientSecret() {
    const value = this.config.get<string>("GOOGLE_CLIENT_SECRET")?.trim();
    if (!value) throw new ServiceUnavailableException("Gmail is not configured. Add the Google OAuth client settings to the API environment.");
    return value;
  }

  private encryptionKey() {
    const encoded = (this.config.get<string>("ENCRYPTION_KEY") || this.config.get<string>("GMAIL_TOKEN_ENCRYPTION_KEY"))?.trim();
    const key = encoded ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
    if (key.length !== 32) throw new ServiceUnavailableException("Set GMAIL_TOKEN_ENCRYPTION_KEY to a base64-encoded 32-byte key in the API environment.");
    return key;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
  }

  private decrypt(value: string) {
    const [ivPart, tagPart, encryptedPart] = value.split(".");
    if (!ivPart || !tagPart || !encryptedPart) throw new ServiceUnavailableException("The saved Gmail token could not be read.");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(), Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8");
  }

  private environmentProviderConfig(provider: "ses" | "resend"): ProviderConfiguration {
    if (provider === "ses") return {
      senderEmail: this.config.get<string>("AWS_SES_FROM_EMAIL")?.trim() || "",
      region: this.config.get<string>("AWS_REGION")?.trim() || "",
      accessKeyId: this.config.get<string>("AWS_ACCESS_KEY_ID")?.trim() || "",
      secretAccessKey: this.config.get<string>("AWS_SECRET_ACCESS_KEY")?.trim() || "",
      configurationSet: this.config.get<string>("AWS_SES_CONFIGURATION_SET")?.trim() || "",
    };
    return {
      senderEmail: this.config.get<string>("RESEND_FROM_EMAIL")?.trim() || "",
      apiKey: this.config.get<string>("RESEND_API_KEY")?.trim() || "",
      webhookSecret: this.config.get<string>("RESEND_WEBHOOK_SECRET")?.trim() || "",
    };
  }

  private async getProviderConfigRow(userId: string, provider: "ses" | "resend"): Promise<ProviderConfigRow | null> {
    if (!this.storage) return this.volatileProviderConfigs.get(`${userId}:${provider}`) || null;
    const { data, error } = await this.storage.from("crm_email_provider_configs")
      .select("user_id,provider,configuration_encrypted,configuration_source,sender_email,is_active,health,last_success_at,last_error")
      .eq("user_id", userId).eq("provider", provider).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not load email-provider settings.");
    return data as ProviderConfigRow | null;
  }

  private async resolvedProviderConfig(userId: string, provider: EmailProviderId): Promise<ProviderConfiguration> {
    if (provider === "gmail") {
      const account = await this.getStoredAccount(userId);
      return { senderEmail: account?.email_address || "" };
    }
    const row = await this.getProviderConfigRow(userId, provider);
    const managed = row && row.configuration_source !== "environment"
      ? JSON.parse(this.decrypt(row.configuration_encrypted)) as ProviderConfiguration
      : {};
    const configured = { ...this.environmentProviderConfig(provider), ...managed };
    if (row?.configuration_source !== "environment" && row?.sender_email) configured.senderEmail = row.sender_email;
    try { configured.webhookUrl = this.publicApiBase + `/outreach/webhooks/${provider}/${encodeURIComponent(userId)}`; }
    catch { configured.webhookUrl = ""; }
    return configured;
  }

  private async persistProviderConfigRow(row: ProviderConfigRow) {
    if (!this.storage) { this.volatileProviderConfigs.set(`${row.user_id}:${row.provider}`, row); return; }
    const { error } = await this.storage.from("crm_email_provider_configs").upsert(row, { onConflict: "user_id,provider" });
    if (error) throw new ServiceUnavailableException("Could not securely save the email-provider settings.");
  }

  private async recordProviderOperation(userId: string, provider: EmailProviderId, config: ProviderConfiguration, error?: unknown) {
    try {
      const lastError = error ? this.safeProviderError(error, config).slice(0, 300) : null;
      if (provider === "gmail") {
        const account = await this.getStoredAccount(userId);
        if (!account) return;
        await this.saveAccount({
          ...account,
          last_success_at: error ? account.last_success_at || null : new Date().toISOString(),
          last_error: lastError,
        });
        return;
      }
      const existing = await this.getProviderConfigRow(userId, provider);
      const row: ProviderConfigRow = {
        user_id: userId,
        provider,
        configuration_encrypted: existing?.configuration_encrypted || this.encrypt(JSON.stringify({})),
        configuration_source: existing?.configuration_source || "environment",
        sender_email: existing?.sender_email || "",
        is_active: existing?.is_active ?? (await this.getDefaultProvider(userId)) === provider,
        health: existing?.health || {},
        last_success_at: error ? existing?.last_success_at || null : new Date().toISOString(),
        last_error: lastError,
      };
      await this.persistProviderConfigRow(row);
    } catch {
      // Provider health is diagnostic. A failure to update it must not change send outcome.
    }
  }

  private async getDefaultProvider(userId: string): Promise<EmailProviderId> {
    if (!this.storage) return this.volatileProviderPreferences.get(userId)?.provider || this.environmentDefaultProvider();
    const { data, error } = await this.storage.from("crm_email_provider_preferences").select("default_provider").eq("user_id", userId).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not load the default email provider.");
    return data?.default_provider ? providerId(data.default_provider) : this.environmentDefaultProvider();
  }

  private environmentDefaultProvider(): EmailProviderId {
    const configured = this.config.get<string>("EMAIL_PROVIDER")?.trim().toLowerCase();
    return configured === "ses" || configured === "resend" || configured === "gmail" ? configured : "gmail";
  }

  private async saveDefaultProvider(userId: string, provider: EmailProviderId) {
    if (!this.storage) { const current = this.volatileProviderPreferences.get(userId); this.volatileProviderPreferences.set(userId, { provider, paused: current?.paused || false }); return; }
    const { error } = await this.storage.from("crm_email_provider_preferences").upsert({ user_id: userId, default_provider: provider, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (error) throw new ServiceUnavailableException("Could not save the default email provider.");
  }

  private async providerStatus(userId: string, provider: EmailProviderId, defaultProvider: EmailProviderId) {
    const account = provider === "gmail" ? await this.getStoredAccount(userId) : null;
    const row = provider === "gmail" ? null : await this.getProviderConfigRow(userId, provider);
    const config = await this.resolvedProviderConfig(userId, provider);
    const adapter = emailProviders[provider];
    const missing = provider === "gmail"
      ? account ? [] : ["connected Gmail mailbox"]
      : adapter.validate(config);
    const domainStatus = provider === "gmail" ? (account ? "connected" : "not connected") : row?.health?.verifiedDomainStatus || "not checked";
    const verified = provider === "gmail" ? Boolean(account) : domainStatus.toLowerCase() === "verified";
    const configured = missing.length === 0 && (provider === "gmail" || verified);
    const envDefault = defaultProvider === provider;
    const active = provider === "gmail" ? Boolean(account) : row ? row.is_active : envDefault && missing.length === 0;
    const health = row?.health;
    const capabilities = adapter.capabilities(config, health);
    return {
      provider,
      name: provider === "gmail" ? "Gmail / Google Workspace" : provider === "ses" ? "Amazon SES" : "Resend (opt-in only)",
      connected: provider === "gmail" ? Boolean(account) : Boolean(row || !missing.length),
      configured,
      active,
      eligibleForSending: active && configured,
      source: provider === "gmail" ? "mailbox" : row?.configuration_source === "workspace" ? "workspace" : "environment",
      senderEmail: provider === "gmail" ? account?.email_address || "" : row?.sender_email || config.senderEmail || "",
      verifiedDomainStatus: domainStatus,
      missingConfiguration: missing,
      capabilities,
      default: defaultProvider === provider,
      lastSuccessAt: provider === "gmail" ? account?.last_success_at || null : row?.last_success_at || null,
      lastError: provider === "gmail" ? account?.last_error || null : row?.last_error || null,
      warning: provider === "ses" && health?.sandbox ? "SES is in sandbox mode. Recipients must be verified until production access is granted." : provider === "resend" ? "Resend is only available for recipients who explicitly opted in; it cannot be used for unsolicited cold outreach." : undefined,
      webhookUrl: provider === "gmail" ? undefined : config.webhookUrl,
      webhookEvents: health?.eventTypes || [],
      sandbox: provider === "ses" ? health?.sandbox : undefined,
    };
  }

  async getProviderSettings(userId: string) {
    const defaultProvider = await this.getDefaultProvider(userId);
    const providers = await Promise.all(providerIds.map((provider) => this.providerStatus(userId, provider, defaultProvider)));
    return { defaultProvider, providers, sendingPaused: await this.isSendingPaused(userId) };
  }

  private async isSendingPaused(userId: string) {
    if (!this.storage) return this.volatileProviderPreferences.get(userId)?.paused || false;
    const { data, error } = await this.storage.from("crm_email_provider_preferences").select("sending_paused").eq("user_id", userId).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not load the global sending control.");
    return Boolean(data?.sending_paused);
  }

  async setSendingPaused(userId: string, value: unknown) {
    if (typeof value !== "boolean") throw new BadRequestException("Choose whether outbound sending should be paused.");
    if (!this.storage) {
      const current = this.volatileProviderPreferences.get(userId);
      this.volatileProviderPreferences.set(userId, { provider: current?.provider || this.environmentDefaultProvider(), paused: value });
    } else {
      const { error } = await this.storage.from("crm_email_provider_preferences").upsert({ user_id: userId, sending_paused: value, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw new ServiceUnavailableException("Could not update the global sending control.");
    }
    return this.getProviderSettings(userId);
  }

  private async isSuppressed(userId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!this.storage) return this.volatileSuppressions.has(`${userId}:${normalized}`);
    const { data, error } = await this.storage.from("crm_email_suppressions").select("email_address").eq("user_id", userId).eq("email_address", normalized).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not verify the recipient suppression list.");
    return Boolean(data);
  }

  private async suppressEmail(userId: string, email: string, reason: "hard_bounce" | "complaint" | "unsubscribe" | "manual", provider: EmailProviderId, sourceEventId: string | null) {
    const normalized = email.trim().toLowerCase();
    if (!normalized || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) return;
    const record = { user_id: userId, email_address: normalized, reason, provider, source_event_id: sourceEventId, created_at: new Date().toISOString() };
    if (!this.storage) { this.volatileSuppressions.set(`${userId}:${normalized}`, record); return; }
    const { error } = await this.storage.from("crm_email_suppressions").upsert(record, { onConflict: "user_id,email_address" });
    if (error) throw new ServiceUnavailableException("Could not save the recipient suppression.");
  }

  async getSuppressions(userId: string) {
    if (!this.storage) return [...this.volatileSuppressions.values()].filter((record) => record.user_id === userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const { data, error } = await this.storage.from("crm_email_suppressions").select("email_address,reason,provider,source_event_id,created_at").eq("user_id", userId).order("created_at", { ascending: false });
    if (error) throw new ServiceUnavailableException("Could not load the recipient suppression list.");
    return data || [];
  }

  async removeSuppression(userId: string, email: string) {
    const normalized = email.trim().toLowerCase();
    if (!this.storage) this.volatileSuppressions.delete(`${userId}:${normalized}`);
    else {
      const { error } = await this.storage.from("crm_email_suppressions").delete().eq("user_id", userId).eq("email_address", normalized);
      if (error) throw new ServiceUnavailableException("Could not remove the recipient suppression.");
    }
    return { removed: true };
  }

  async updateProviderSettings(userId: string, providerValue: unknown, value: unknown) {
    const provider = providerId(providerValue);
    if (provider === "gmail") {
      if (isRecord(value) && value.active === true && !(await this.getStoredAccount(userId))) throw new BadRequestException("Connect Gmail before activating it.");
      return this.getProviderSettings(userId);
    }
    if (!isRecord(value)) throw new BadRequestException("Enter the provider settings to save.");
    const currentRow = await this.getProviderConfigRow(userId, provider);
    const current = await this.resolvedProviderConfig(userId, provider);
    const inputText = (key: string, previous: string | undefined) => typeof value[key] === "string" && (value[key] as string).trim() ? (value[key] as string).trim() : previous || "";
    const next: ProviderConfiguration = provider === "ses" ? {
      senderEmail: inputText("senderEmail", current.senderEmail),
      region: inputText("region", current.region),
      accessKeyId: inputText("accessKeyId", current.accessKeyId),
      secretAccessKey: inputText("secretAccessKey", current.secretAccessKey),
      configurationSet: inputText("configurationSet", current.configurationSet),
    } : {
      senderEmail: inputText("senderEmail", current.senderEmail),
      apiKey: inputText("apiKey", current.apiKey),
      webhookSecret: inputText("webhookSecret", current.webhookSecret),
    };
    const isActive = typeof value.active === "boolean" ? value.active : currentRow?.is_active ?? false;
    if (isActive && emailProviders[provider].validate(next).length) throw new BadRequestException(`Complete the required ${provider === "ses" ? "Amazon SES" : "Resend"} settings before activating this provider.`);
    const oldValues = provider === "ses"
      ? [current.senderEmail, current.region, current.configurationSet, current.accessKeyId, current.secretAccessKey]
      : [current.senderEmail, current.apiKey, current.webhookSecret];
    const newValues = provider === "ses"
      ? [next.senderEmail, next.region, next.configurationSet, next.accessKeyId, next.secretAccessKey]
      : [next.senderEmail, next.apiKey, next.webhookSecret];
    const configurationChanged = JSON.stringify(oldValues) !== JSON.stringify(newValues);
    const row: ProviderConfigRow = {
      user_id: userId,
      provider,
      configuration_encrypted: this.encrypt(JSON.stringify(next)),
      configuration_source: "workspace",
      sender_email: next.senderEmail,
      is_active: isActive,
      health: configurationChanged ? {} : currentRow?.health || {},
      last_success_at: configurationChanged ? null : currentRow?.last_success_at || null,
      last_error: configurationChanged ? null : currentRow?.last_error || null,
    };
    await this.persistProviderConfigRow(row);
    return this.getProviderSettings(userId);
  }

  async testProvider(userId: string, providerValue: unknown) {
    const provider = providerId(providerValue);
    const adapter = emailProviders[provider];
    const config = await this.resolvedProviderConfig(userId, provider);
    if (provider === "gmail") {
      const accessToken = await this.getAccessToken(userId);
      config.accessToken = accessToken;
      adapter.validate(config);
      try {
        const result = await adapter.test(config);
        await this.recordProviderOperation(userId, provider, config);
        return { result, settings: await this.getProviderSettings(userId) };
      } catch (error) {
        await this.recordProviderOperation(userId, provider, config, error);
        throw error;
      }
    }
    const row = await this.getProviderConfigRow(userId, provider);
    const missing = adapter.validate(config);
    if (missing.length) throw new BadRequestException(`Missing ${provider === "ses" ? "Amazon SES" : "Resend"} configuration: ${missing.join(", " )}.`);
    try {
      const result = await adapter.test(config);
      const updated: ProviderConfigRow = {
        user_id: userId,
        provider,
        configuration_encrypted: row?.configuration_encrypted || this.encrypt(JSON.stringify({})),
        configuration_source: row?.configuration_source || "environment",
        sender_email: row?.sender_email || "",
        is_active: row?.is_active ?? (await this.getDefaultProvider(userId)) === provider,
        health: provider === "ses" ? { ...result, snsSubscriptionConfirmedAt: row?.health?.snsSubscriptionConfirmedAt } : result,
        last_success_at: new Date().toISOString(),
        last_error: null,
      };
      await this.persistProviderConfigRow(updated);
      return { result, settings: await this.getProviderSettings(userId) };
    } catch (error) {
      const updated: ProviderConfigRow = {
        user_id: userId,
        provider,
        configuration_encrypted: row?.configuration_encrypted || this.encrypt(JSON.stringify({})),
        configuration_source: row?.configuration_source || "environment",
        sender_email: row?.sender_email || "",
        is_active: row?.is_active ?? (await this.getDefaultProvider(userId)) === provider,
        health: row?.health || {},
        last_success_at: row?.last_success_at || null,
        last_error: this.safeProviderError(error, config),
      };
      await this.persistProviderConfigRow(updated);
      throw new BadGatewayException(updated.last_error || "Provider connection failed.");
    }
  }

  async setDefaultProvider(userId: string, providerValue: unknown) {
    const provider = providerId(providerValue);
    const status = await this.providerStatus(userId, provider, await this.getDefaultProvider(userId));
    if (!status.eligibleForSending) throw new BadRequestException(`${status.name} is not configured, verified, and active for sending.`);
    await this.saveDefaultProvider(userId, provider);
    return this.getProviderSettings(userId);
  }

  private async getStoredAccount(userId: string): Promise<StoredAccount | null> {
    if (!this.storage) return this.volatileAccounts.get(userId) || null;
    const { data, error } = await this.storage.from("crm_email_accounts").select("user_id,email_address,refresh_token_encrypted,access_token_encrypted,access_token_expires_at,history_id,last_success_at,last_error").eq("user_id", userId).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not load the connected Gmail account.");
    return data as StoredAccount | null;
  }

  private async saveAccount(account: StoredAccount) {
    if (!this.storage) { this.volatileAccounts.set(account.user_id, account); return; }
    const { error } = await this.storage.from("crm_email_accounts").upsert(account, { onConflict: "user_id" });
    if (error) throw new ServiceUnavailableException("Could not securely save the Gmail connection.");
  }

  async getGmailStatus(userId: string) {
    const account = await this.getStoredAccount(userId);
    return account ? { connected: true, email: account.email_address } : { connected: false };
  }

  beginGmailConnection(userId: string) {
    const clientId = this.googleClientId();
    this.googleClientSecret();
    this.encryptionKey();
    const statePayload = Buffer.from(JSON.stringify({ userId, expiresAt: Date.now() + 10 * 60 * 1000, nonce: randomBytes(24).toString("base64url") })).toString("base64url");
    const stateSignature = createHmac("sha256", this.encryptionKey()).update(statePayload).digest("base64url");
    const state = `${statePayload}.${stateSignature}`;
    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.searchParams.set("client_id", clientId);
    authorization.searchParams.set("redirect_uri", this.redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.metadata",
      "https://www.googleapis.com/auth/gmail.readonly",
    ].join(" "));
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("prompt", "consent");
    authorization.searchParams.set("include_granted_scopes", "true");
    authorization.searchParams.set("state", state);
    return { authorizationUrl: authorization.toString() };
  }

  async completeGmailConnection(code: string, state: string) {
    if (!code || !state) throw new BadRequestException("Gmail authorization expired. Please connect again.");
    const [statePayload, signature] = state.split(".");
    if (!statePayload || !signature) throw new BadRequestException("Gmail authorization state is invalid.");
    const expectedSignature = createHmac("sha256", this.encryptionKey()).update(statePayload).digest();
    const receivedSignature = Buffer.from(signature, "base64url");
    if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) throw new BadRequestException("Gmail authorization state is invalid.");
    let pending: { userId: string; expiresAt: number };
    try { pending = JSON.parse(Buffer.from(statePayload, "base64url").toString("utf8")) as typeof pending; }
    catch { throw new BadRequestException("Gmail authorization state is invalid."); }
    if (!pending.userId || pending.expiresAt < Date.now()) throw new BadRequestException("Gmail authorization expired. Please connect again.");
    const body = new URLSearchParams({
      code,
      client_id: this.googleClientId(),
      client_secret: this.googleClientSecret(),
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    });
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const tokens = await response.json() as OAuthTokens;
    if (!response.ok || !tokens.access_token) throw new BadGatewayException("Google could not authorize this Gmail account.");
    const previous = await this.getStoredAccount(pending.userId);
    const refreshToken = tokens.refresh_token || (previous ? this.decrypt(previous.refresh_token_encrypted) : "");
    if (!refreshToken) throw new BadGatewayException("Google did not return a refresh token. Revoke the app in your Google Account and connect again.");
    const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    const profile = await profileResponse.json() as { emailAddress?: string; historyId?: string };
    if (!profileResponse.ok || !profile.emailAddress) throw new BadGatewayException("Could not read the connected Gmail address.");
    await this.saveAccount({
      user_id: pending.userId,
      email_address: profile.emailAddress,
      refresh_token_encrypted: this.encrypt(refreshToken),
      access_token_encrypted: this.encrypt(tokens.access_token),
      access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      history_id: profile.historyId || previous?.history_id || null,
    });
  }

  async disconnectGmail(userId: string) {
    const account = await this.getStoredAccount(userId);
    if (account) {
      try {
        const token = this.decrypt(account.refresh_token_encrypted);
        await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
      } catch { /* Remove local access even if Google's revocation endpoint is unavailable. */ }
    }
    if (!this.storage) this.volatileAccounts.delete(userId);
    else {
      const { error } = await this.storage.from("crm_email_accounts").delete().eq("user_id", userId);
      if (error) throw new ServiceUnavailableException("Could not remove the Gmail connection.");
    }
    return { disconnected: true };
  }

  private async getAccessToken(userId: string) {
    const account = await this.getStoredAccount(userId);
    if (!account) throw new BadRequestException("Connect Gmail before sending or syncing outreach.");
    if (account.access_token_expires_at && new Date(account.access_token_expires_at).getTime() > Date.now() + 60_000) return this.decrypt(account.access_token_encrypted);
    const refreshToken = this.decrypt(account.refresh_token_encrypted);
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.googleClientId(), client_secret: this.googleClientSecret(), refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const tokens = await response.json() as OAuthTokens;
    if (!response.ok || !tokens.access_token) throw new BadGatewayException("Gmail authorization expired. Disconnect and connect your account again.");
    const updated = { ...account, access_token_encrypted: this.encrypt(tokens.access_token), access_token_expires_at: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() };
    await this.saveAccount(updated);
    return tokens.access_token;
  }

  private async getRows(userId: string): Promise<MessageRow[]> {
    if (!this.storage) return [...(this.volatileMessages.get(userId) || [])].sort((a, b) => (b.sent_at || "").localeCompare(a.sent_at || ""));
    const { data, error } = await this.storage.from("crm_outreach_messages").select(outreachMessageColumns).eq("user_id", userId).order("sent_at", { ascending: false, nullsFirst: false }).limit(1000);
    if (error) throw new ServiceUnavailableException("Could not load outreach messages.");
    return (data || []) as MessageRow[];
  }

  private async getAllMessageRows(userId: string): Promise<MessageRow[]> {
    const storage = this.storage;
    if (!storage) return this.getRows(userId);
    const rows: MessageRow[] = [];
    const pageSize = 1000;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await storage.from("crm_outreach_messages")
        .select(outreachMessageColumns)
        .eq("user_id", userId)
        .order("sent_at", { ascending: false, nullsFirst: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ServiceUnavailableException("Could not load outreach messages.");
      const page = (data || []) as MessageRow[];
      rows.push(...page);
      if (page.length < pageSize) return rows;
    }
  }

  private async saveMessage(row: MessageRow) {
    if (!this.storage) {
      const rows = this.volatileMessages.get(row.user_id) || [];
      const index = rows.findIndex((item) => item.id === row.id);
      if (index >= 0) rows[index] = row; else rows.unshift(row);
      this.volatileMessages.set(row.user_id, rows);
      return;
    }
    const { error } = await this.storage.from("crm_outreach_messages").upsert(row, { onConflict: "user_id,id" });
    if (error) throw new ServiceUnavailableException("Could not save the outreach message and its tracking details.");
  }

  private async createSendingMessage(row: MessageRow) {
    if (!this.storage) {
      const existing = (this.volatileMessages.get(row.user_id) || []).find((item) => item.idempotency_key === row.idempotency_key);
      if (existing) return { row: existing, created: false };
      const rows = this.volatileMessages.get(row.user_id) || [];
      rows.unshift(row);
      this.volatileMessages.set(row.user_id, rows);
      return { row, created: true };
    }
    const { data, error } = await this.storage.from("crm_outreach_messages").insert(row).select("id,user_id,contact_id,opportunity_id,recipient,recipient_name,subject,body,status,sent_at,replied_at,gmail_message_id,gmail_thread_id,provider,sender_account,provider_message_id,provider_thread_id,provider_capabilities,idempotency_key,recipient_opted_in,click_count,created_at").single();
    if (!error && data) return { row: data as MessageRow, created: true };
    if (error?.code !== "23505") throw new ServiceUnavailableException("Could not safely create the outbound message record.");
    const { data: existing, error: lookupError } = await this.storage.from("crm_outreach_messages").select("id,user_id,contact_id,opportunity_id,recipient,recipient_name,subject,body,status,sent_at,replied_at,gmail_message_id,gmail_thread_id,provider,sender_account,provider_message_id,provider_thread_id,provider_capabilities,idempotency_key,recipient_opted_in,click_count,created_at").eq("user_id", row.user_id).eq("idempotency_key", row.idempotency_key).maybeSingle();
    if (lookupError || !existing) throw new ConflictException("This send request already exists. Check the outreach history before trying again.");
    return { row: existing as MessageRow, created: false };
  }

  private async findMessageByProviderId(userId: string, provider: EmailProviderId, providerMessageId: string) {
    if (!this.storage) return (this.volatileMessages.get(userId) || []).find((row) => row.provider === provider && row.provider_message_id === providerMessageId) || null;
    const { data, error } = await this.storage.from("crm_outreach_messages").select("id,user_id,contact_id,opportunity_id,recipient,recipient_name,subject,body,status,sent_at,replied_at,gmail_message_id,gmail_thread_id,provider,sender_account,provider_message_id,provider_thread_id,provider_capabilities,idempotency_key,recipient_opted_in,click_count,created_at")
      .eq("user_id", userId).eq("provider", provider).eq("provider_message_id", providerMessageId).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not correlate the provider event to its message.");
    return data as MessageRow | null;
  }

  private async recordEmailEvent(event: StoredEmailEvent, correlateByProviderId = true) {
    if (!eventTypes.has(event.event_type)) return { processed: false, reason: "unsupported event" };
    let row: MessageRow | null = null;
    if (event.message_id) {
      if (!this.storage) row = (this.volatileMessages.get(event.user_id) || []).find((item) => item.id === event.message_id) || null;
      else {
        const { data } = await this.storage.from("crm_outreach_messages").select("id,user_id,contact_id,opportunity_id,recipient,recipient_name,subject,body,status,sent_at,replied_at,gmail_message_id,gmail_thread_id,provider,sender_account,provider_message_id,provider_thread_id,provider_capabilities,idempotency_key,recipient_opted_in,click_count,created_at").eq("user_id", event.user_id).eq("id", event.message_id).maybeSingle();
        row = data as MessageRow | null;
      }
    }
    if (!row && correlateByProviderId && event.provider_message_id) row = await this.findMessageByProviderId(event.user_id, event.provider, event.provider_message_id);
    if (row && row.provider !== event.provider) row = null;
    event.message_id = row?.id || null;
    if (!this.storage) {
      if (!this.volatileEvents.some((item) => item.provider === event.provider && item.provider_event_id === event.provider_event_id)) this.volatileEvents.push(event);
    } else {
      const { error } = await this.storage.from("crm_email_events").upsert(event, { onConflict: "provider,provider_event_id", ignoreDuplicates: true });
      if (error) throw new ServiceUnavailableException("Could not save the normalized email event.");
    }
    if (row) {
      const next = { ...row };
      if (event.event_type === "reply_received") {
        next.replied_at ||= event.event_timestamp;
        next.status = "replied";
      } else if (event.event_type === "delivered" && next.status === "accepted") next.status = "delivered";
      else if (event.event_type === "bounced") next.status = "bounced";
      else if (event.event_type === "complaint") next.status = "complained";
      else if (event.event_type === "failed") next.status = "failed";
      await this.saveMessage(next);
    }
    const bounce = isRecord(event.details.bounce) ? event.details.bounce : {};
    const bounceType = String(bounce.type || "").toLowerCase();
    const hardBounce = event.event_type === "bounced" && (bounceType === "permanent" || bounceType === "hard");
    if (event.event_type === "complaint" || event.event_type === "unsubscribed" || hardBounce) {
      const reason = event.event_type === "complaint" ? "complaint" : event.event_type === "unsubscribed" ? "unsubscribe" : "hard_bounce";
      const addresses = new Set<string>();
      if (row?.recipient) addresses.add(row.recipient);
      if (typeof event.details.recipient === "string") addresses.add(event.details.recipient);
      const recipients = bounce.recipients;
      if (Array.isArray(recipients)) recipients.forEach((recipient) => {
        if (isRecord(recipient) && typeof recipient.emailAddress === "string") addresses.add(recipient.emailAddress);
        if (isRecord(recipient) && typeof recipient.email === "string") addresses.add(recipient.email);
      });
      for (const address of addresses) await this.suppressEmail(event.user_id, address, reason, event.provider, event.provider_event_id);
    }
    return { processed: true, messageId: row?.id || null };
  }

  private toMessage(row: MessageRow) {
    return {
      id: row.id, contactId: row.contact_id, opportunityId: row.opportunity_id || undefined,
      recipient: row.recipient, recipientName: row.recipient_name, subject: row.subject, body: row.body,
      status: row.status, sentAt: row.sent_at || "", repliedAt: row.replied_at || undefined,
      clickCount: row.click_count || 0,
      provider: row.provider || "gmail", senderAccount: row.sender_account || undefined,
      providerMessageId: row.provider_message_id || row.gmail_message_id || undefined,
      providerThreadId: row.provider_thread_id || row.gmail_thread_id || undefined,
      capabilities: row.provider_capabilities || emailProviders.gmail.capabilities({ senderEmail: row.sender_account || "" }),
      gmailThreadUrl: (row.provider_thread_id || row.gmail_thread_id) && !row.provider_thread_id?.startsWith("crm-thread:")
        ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(row.provider_thread_id || row.gmail_thread_id || "")}`
        : undefined,
    };
  }

  async getMessages(userId: string) {
    return (await this.getAllMessageRows(userId)).map((row) => this.toMessage(row));
  }

  private decodeGmailBody(value: string) {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }

  private htmlToText(value: string) {
    const entities: Record<string, string> = {
      amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"",
      ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
    };
    return value
      .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<(?:blockquote|div)\b(?=[^>]*(?:class=["'][^"']*(?:gmail_quote|gmail_extra|yahoo_quoted)[^"']*["']|type=["']cite["']))[^>]*>[\s\S]*$/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
      .replace(/<[^>]*>/g, "")
      .replace(/&#(x[0-9a-f]+|\d+);/gi, (entity, code: string) => {
        const point = code[0].toLowerCase() === "x"
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);
        return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      })
      .replace(/&([a-z]+);/gi, (entity, name: string) => entities[name.toLowerCase()] ?? entity)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private cleanGmailText(value: string) {
    const quoteBoundary = /^\s*(?:On .{1,240}\bwrote:\s*|[-_]{2,}\s*Original Message\s*[-_]{2,}|Begin forwarded message:)\s*$/i;
    const lines: string[] = [];
    for (const line of value.replace(/\r\n?/g, "\n").split("\n")) {
      if (quoteBoundary.test(line) || /^\s*>/.test(line)) break;
      lines.push(line);
    }
    return lines.join("\n")
      .replace(/<([^<>\n]+)>/g, "$1")
      .replace(/[<>]/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private gmailBody(payload: Record<string, unknown>): string {
    const body = isRecord(payload.body) ? payload.body : {};
    const data = typeof body.data === "string" ? body.data : "";
    const mimeType = String(payload.mimeType || "");
    if (mimeType === "text/plain" && data) {
      const text = this.decodeGmailBody(data);
      return this.cleanGmailText(/<(?:html|body|div|p|br|table|span|a|ul|ol|blockquote)\b/i.test(text) ? this.htmlToText(text) : text);
    }
    const parts = Array.isArray(payload.parts) ? payload.parts.filter(isRecord) : [];
    const plainParts = parts.filter((part) => part.mimeType === "text/plain");
    if (plainParts.length) return plainParts.map((part) => this.gmailBody(part)).filter(Boolean).join("\n").trim();
    const nested = parts.map((part) => this.gmailBody(part)).find(Boolean);
    if (nested) return nested;
    if (mimeType === "text/html" && data) {
      return this.cleanGmailText(this.htmlToText(this.decodeGmailBody(data)));
    }
    return "";
  }

  private async readGmailThread(userId: string, row: MessageRow, threadId: string) {
    const account = await this.getStoredAccount(userId);
    if (!account) return null;
    const accessToken = await this.getAccessToken(userId);
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`);
    url.searchParams.set("format", "full");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 403) {
      throw new ServiceUnavailableException("Gmail has not granted permission to read thread contents. Disconnect and reconnect Gmail to approve read-only access.");
    }
    if (!response.ok) throw new ServiceUnavailableException("Could not load this Gmail conversation. Reconnect Gmail and try again.");
    const thread = await response.json() as {
      messages?: Array<{
        id?: string;
        internalDate?: string;
        payload?: Record<string, unknown> & { headers?: Array<{ name?: string; value?: string }> };
      }>;
    };
    const messages = (thread.messages || []).map((message) => {
      const headers = message.payload?.headers || [];
      const header = (name: string) => headers.find((item) => item.name?.toLowerCase() === name.toLowerCase())?.value || "";
      const from = header("From");
      return {
        id: message.id || "",
        from,
        to: header("To"),
        subject: header("Subject") || row.subject,
        rfcMessageId: header("Message-ID"),
        references: header("References"),
        sentAt: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : "",
        body: message.payload ? this.gmailBody(message.payload) : "",
        providerThreadId: threadId,
        direction: addressOf(from) === account.email_address.toLowerCase() ? "sent" as const : "received" as const,
      };
    }).filter((message) => message.id);
    return { threadId, messages };
  }

  async getMessageThread(userId: string, messageId: string) {
    const allRows = await this.getAllMessageRows(userId);
    const row = allRows.find((message) => message.id === messageId);
    if (!row) throw new NotFoundException("This outreach message was not found.");
    const rows = allRows.filter((item) => item.contact_id === row.contact_id)
      .sort((a, b) => (a.sent_at || a.created_at || "").localeCompare(b.sent_at || b.created_at || ""));
    const storedMessages = rows.map((item) => ({
      id: item.provider_message_id || item.id,
      from: item.sender_account || "",
      to: item.recipient,
      subject: item.subject,
      sentAt: item.sent_at || item.created_at || "",
      body: item.body,
      providerThreadId: item.provider_thread_id?.startsWith("crm-thread:")
        ? item.provider_thread_id
        : item.provider_thread_id || item.gmail_thread_id || `crm-thread:${item.id}`,
      direction: "sent" as const,
    }));
    const gmailThreadIds = [...new Set(rows.map((item) => item.provider === "gmail"
      ? item.provider_thread_id || item.gmail_thread_id
      : item.gmail_thread_id).filter((id): id is string => Boolean(id && !id.startsWith("crm-thread:"))))];
    const account = await this.getStoredAccount(userId);
    const gmailMessages: Array<{
      id: string; from: string; to: string; subject: string; sentAt: string; body: string;
      providerThreadId: string; direction: "sent" | "received"; rfcMessageId?: string; references?: string;
    }> = [];
    if (account && gmailThreadIds.length) {
      for (let offset = 0; offset < gmailThreadIds.length; offset += 5) {
        const batch = gmailThreadIds.slice(offset, offset + 5);
        const threadResults = await Promise.all(batch.map((threadId) => {
          const threadRow = rows.find((item) => item.provider_thread_id === threadId || item.gmail_thread_id === threadId) || row;
          return this.readGmailThread(userId, threadRow, threadId);
        }));
        gmailMessages.push(...threadResults.flatMap((result) => result?.messages || []));
      }
    }
    const messages = [...gmailMessages, ...storedMessages]
      .filter((message, index, all) => all.findIndex((candidate) => candidate.id === message.id) === index)
      .sort((a, b) => (a.sentAt || "").localeCompare(b.sentAt || ""));
    const latestMessage = messages[messages.length - 1];
    const targetThreadId = latestMessage?.providerThreadId || "";
    const targetRows = targetThreadId.startsWith("crm-thread:")
      ? rows.filter((item) => item.id === targetThreadId.slice("crm-thread:".length) || item.provider_thread_id === targetThreadId)
      : rows.filter((item) => item.provider_thread_id === targetThreadId || item.gmail_thread_id === targetThreadId);
    const replyTarget = (targetRows.length ? targetRows : rows).slice().sort((a, b) =>
      (b.sent_at || b.created_at || "").localeCompare(a.sent_at || a.created_at || ""))[0];
    const selectedThreadId = row.provider_thread_id?.startsWith("crm-thread:")
      ? row.provider_thread_id
      : row.provider_thread_id || row.gmail_thread_id || null;
    return {
      threadId: selectedThreadId,
      source: gmailMessages.length ? "gmail" : "crm",
      replyTargetId: replyTarget?.id || row.id,
      messages,
    };
  }

  async sendReply(userId: string, messageId: string, value: unknown) {
    if (!isRecord(value) || typeof value.body !== "string" || !value.body.trim()) {
      throw new BadRequestException("Enter a message before sending your reply.");
    }
    const parent = (await this.getAllMessageRows(userId)).find((item) => item.id === messageId);
    if (!parent) throw new NotFoundException("This outreach conversation was not found.");
    if (!["sent", "accepted", "delivered", "replied"].includes(parent.status)) {
      throw new ConflictException("This email cannot be replied to because it was not successfully sent.");
    }
    const parentThreadId = parent.provider_thread_id || parent.gmail_thread_id;
    let conversationId = parent.provider_thread_id?.startsWith("crm-thread:")
      ? parent.provider_thread_id
      : `crm-thread:${parent.id}`;
    let threadId: string | undefined;
    let inReplyTo: string | undefined;
    let references: string | undefined;
    if (parent.provider === "gmail" && parentThreadId) {
      const thread = await this.readGmailThread(userId, parent, parentThreadId);
      threadId = thread?.threadId || parentThreadId;
      conversationId = threadId;
      const latestMessage = thread?.messages[thread.messages.length - 1];
      inReplyTo = latestMessage?.rfcMessageId || undefined;
      references = [latestMessage?.references, inReplyTo].filter(Boolean).join(" ") || undefined;
    }
    const subject = /^re:\s*/i.test(parent.subject) ? parent.subject : `Re: ${parent.subject}`;
    return this.sendMessage(userId, {
      contactId: parent.contact_id,
      opportunityId: parent.opportunity_id || undefined,
      subject,
      body: value.body.trim(),
      senderName: typeof value.senderName === "string" ? value.senderName : "",
      provider: parent.provider,
      recipientOptedIn: parent.recipient_opted_in,
      idempotencyKey: value.idempotencyKey,
    }, { threadId, inReplyTo, references, conversationId });
  }

  async getMeetings(userId: string) {
    if (!this.storage) {
      return [...(this.volatileMeetings.get(userId) || [])]
        .sort((a, b) => b.start_time.localeCompare(a.start_time))
        .map((row) => this.toCalendarMeeting(row));
    }
    const { data, error } = await this.storage.from("crm_calendar_bookings")
      .select("user_id,cal_uid,contact_id,title,attendee_name,attendee_email,start_time,end_time,location,status,created_at,updated_at")
      .eq("user_id", userId).order("start_time", { ascending: false }).limit(500);
    if (error) throw new ServiceUnavailableException("Could not load calendar bookings.");
    return ((data || []) as CalendarMeetingRow[]).map((row) => this.toCalendarMeeting(row));
  }

  private toCalendarMeeting(row: CalendarMeetingRow) {
    return {
      id: row.cal_uid,
      contactId: row.contact_id || undefined,
      title: row.title,
      attendeeName: row.attendee_name,
      attendeeEmail: row.attendee_email,
      startTime: row.start_time,
      endTime: row.end_time,
      location: row.location || undefined,
      status: row.status,
    };
  }

  async getCalendarSettings(userId: string) {
    let configured = this.volatileCalendarSecrets.has(userId);
    if (this.storage) {
      const { data, error } = await this.storage.from("crm_cal_webhook_configs").select("user_id").eq("user_id", userId).maybeSingle();
      if (error) throw new ServiceUnavailableException("Could not load the Cal.com webhook configuration.");
      configured = Boolean(data);
    }
    return {
      configured,
      webhookUrl: `${this.publicApiBase}/outreach/calendar/webhook/${encodeURIComponent(userId)}`,
    };
  }

  private async getGroqSettingsRow(userId: string): Promise<GroqSettingsRow | null> {
    if (!this.storage) return this.volatileGroqSettings.get(userId) || null;
    const { data, error } = await this.storage.from("crm_groq_settings")
      .select("user_id,api_key_encrypted,model,last_tested_at,last_error")
      .eq("user_id", userId).maybeSingle();
    if (error) throw new ServiceUnavailableException("Could not load AI email settings.");
    return data as GroqSettingsRow | null;
  }

  private async resolvedGroqConfig(userId: string) {
    const row = await this.getGroqSettingsRow(userId);
    const workspaceKey = row?.api_key_encrypted ? this.decrypt(row.api_key_encrypted) : "";
    const environmentKey = this.config.get<string>("GROQ_API_KEY")?.trim() || "";
    return {
      row,
      apiKey: workspaceKey || environmentKey,
      keySource: workspaceKey ? "workspace" as const : environmentKey ? "environment" as const : "unconfigured" as const,
      model: row?.model || this.config.get<string>("GROQ_MODEL")?.trim() || "openai/gpt-oss-20b",
      hasWorkspaceKey: Boolean(workspaceKey),
    };
  }

  async getGroqDraftSettings(userId: string) {
    const settings = await this.resolvedGroqConfig(userId);
    return {
      configured: Boolean(settings.apiKey),
      keySource: settings.keySource,
      hasWorkspaceKey: settings.hasWorkspaceKey,
      model: settings.model,
      lastTestedAt: settings.row?.last_tested_at || null,
      lastError: settings.row?.last_error || null,
    };
  }

  async updateGroqDraftSettings(userId: string, value: unknown) {
    if (!isRecord(value)) throw new BadRequestException("Enter a valid model and optional Groq API key.");
    const current = await this.getGroqSettingsRow(userId);
    const model = typeof value.model === "string" && value.model.trim()
      ? value.model.trim().slice(0, 150)
      : current?.model || this.config.get<string>("GROQ_MODEL")?.trim() || "openai/gpt-oss-20b";
    if (!/^[a-zA-Z0-9._/-]+$/.test(model)) throw new BadRequestException("Enter a valid Groq model ID.");
    const clearWorkspaceKey = value.clearWorkspaceKey === true;
    const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
    const encryptedKey = apiKey ? this.encrypt(apiKey) : clearWorkspaceKey ? null : current?.api_key_encrypted || null;
    const configurationChanged = model !== current?.model
      || Boolean(apiKey)
      || (clearWorkspaceKey && Boolean(current?.api_key_encrypted));
    const row: GroqSettingsRow = {
      user_id: userId,
      api_key_encrypted: encryptedKey,
      model,
      last_tested_at: configurationChanged ? null : current?.last_tested_at || null,
      last_error: null,
    };
    if (this.storage) {
      const { error } = await this.storage.from("crm_groq_settings").upsert(row, { onConflict: "user_id" });
      if (error) throw new ServiceUnavailableException("Could not save AI email settings.");
    } else this.volatileGroqSettings.set(userId, row);
    return this.getGroqDraftSettings(userId);
  }

  private async groqCompletion(apiKey: string, model: string, messages: Array<{ role: "system" | "user"; content: string }>, maxTokens = 1200) {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.6, max_completion_tokens: maxTokens }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: { message?: string } };
      const detail = response.status === 401 ? "Groq rejected the API key." : response.status === 404 ? "The selected Groq model was not found." : "Groq could not generate a response.";
      throw new ServiceUnavailableException(payload.error?.message ? `${detail} ${payload.error.message.slice(0, 240)}` : detail);
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return payload.choices?.[0]?.message?.content?.trim() || "";
  }

  async testGroqDraftSettings(userId: string) {
    const settings = await this.resolvedGroqConfig(userId);
    if (!settings.apiKey) throw new BadRequestException("Add a Groq API key in AI email drafting settings, or set GROQ_API_KEY on the API server.");
    const response = await this.groqCompletion(settings.apiKey, settings.model, [
      { role: "user", content: "Reply with the single word OK." },
    ], 256);
    if (!response) throw new ServiceUnavailableException("Groq accepted the request but returned no generated text. Check that the selected model supports chat completions, then try again.");
    const testedAt = new Date().toISOString();
    const updated: GroqSettingsRow = {
      user_id: userId,
      api_key_encrypted: settings.row?.api_key_encrypted || null,
      model: settings.model,
      last_tested_at: testedAt,
      last_error: null,
    };
    if (this.storage) {
      const { error } = await this.storage.from("crm_groq_settings").upsert(updated, { onConflict: "user_id" });
      if (error) throw new ServiceUnavailableException("Groq tested successfully, but the test status could not be saved.");
    } else this.volatileGroqSettings.set(userId, updated);
    return { settings: await this.getGroqDraftSettings(userId), result: { model: settings.model } };
  }

  async createAiOutreachDraft(userId: string, value: unknown) {
    if (!isRecord(value) || typeof value.contactId !== "string") throw new BadRequestException("Choose a contact before generating a draft.");
    const settings = await this.resolvedGroqConfig(userId);
    if (!settings.apiKey) throw new BadRequestException("Add a Groq API key in AI email drafting settings, or set GROQ_API_KEY on the API server.");
    const workspace = await this.workspaceService.getWorkspace(userId);
    const contact = workspace.data.contacts.find((item) => item.id === value.contactId && !item.archived);
    if (!contact) throw new BadRequestException("Choose a contact from this workspace.");
    const opportunity = typeof value.opportunityId === "string"
      ? workspace.data.opportunities.find((item) => item.id === value.opportunityId && !item.archived)
      : undefined;
    if (value.opportunityId && !opportunity) throw new BadRequestException("Choose an opportunity from this workspace.");
    const company = workspace.data.companies.find((item) => item.id === contact.companyId);
    const language = typeof value.language === "string" && value.language.trim() ? value.language.trim().slice(0, 80) : "English";
    const brief = typeof value.brief === "string" ? value.brief.trim().slice(0, 2000) : "";
    const senderName = typeof value.senderName === "string" ? value.senderName.trim().slice(0, 100) : "";
    const details = [
      `Prospect first name: ${String(contact.firstName || "there")}`,
      `Company: ${String(company?.name || "Not specified")}`,
      `Role: ${String(contact.jobTitle || "Not specified")}`,
      `Country or region: ${String(contact.country || "Not specified")}`,
      `Opportunity: ${String(opportunity?.title || "Not specified")}`,
      `Sender name: ${senderName || "Not specified"}`,
      `Language: ${language}`,
      `User brief: ${brief || "Write a concise, relevant introduction and ask for a short meeting."}`,
    ].join("\n");
    const content = await this.groqCompletion(settings.apiKey, settings.model, [
      { role: "system", content: "Write a concise, natural, personalized first-contact business outreach email. Do not invent facts, make exaggerated claims, or include a subject inside the body. Return only valid JSON with exactly two string fields: subject and body." },
      { role: "user", content: details },
    ]);
    let draft: unknown;
    try { draft = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim()); } catch { throw new ServiceUnavailableException("Groq returned an invalid email draft. Try again or adjust the brief."); }
    if (!isRecord(draft) || typeof draft.subject !== "string" || typeof draft.body !== "string" || !draft.subject.trim() || !draft.body.trim()) {
      throw new ServiceUnavailableException("Groq returned an incomplete email draft. Try again.");
    }
    return { subject: draft.subject.trim().slice(0, 998), body: draft.body.trim().slice(0, 40000), model: settings.model };
  }

  async createAiReplyDraft(userId: string, messageId: string, value: unknown) {
    const parent = (await this.getAllMessageRows(userId)).find((item) => item.id === messageId);
    if (!parent) throw new NotFoundException("This outreach conversation was not found.");
    if (!["sent", "accepted", "delivered", "replied"].includes(parent.status)) {
      throw new ConflictException("An AI reply can only be drafted for a successfully sent conversation.");
    }
    const settings = await this.resolvedGroqConfig(userId);
    if (!settings.apiKey) throw new BadRequestException("Add a Groq API key in AI email drafting settings, or set GROQ_API_KEY on the API server.");
    const workspace = await this.workspaceService.getWorkspace(userId);
    const contact = workspace.data.contacts.find((item) => item.id === parent.contact_id && !item.archived);
    if (!contact) throw new NotFoundException("The contact for this conversation was not found.");
    const opportunity = parent.opportunity_id
      ? workspace.data.opportunities.find((item) => item.id === parent.opportunity_id && !item.archived)
      : undefined;
    const company = workspace.data.companies.find((item) => item.id === contact.companyId);
    const thread = await this.getMessageThread(userId, messageId);
    const recentMessages = thread.messages
      .filter((item) => item.body.trim())
      .slice(-12)
      .map((item) => ({
        direction: item.direction,
        date: item.sentAt,
        body: item.body.slice(0, 5000),
      }));
    if (!recentMessages.length) throw new BadRequestException("This conversation has no message content for AI to use.");
    const instructions = isRecord(value) && typeof value.instructions === "string"
      ? value.instructions.trim().slice(0, 2000)
      : "";
    const senderName = isRecord(value) && typeof value.senderName === "string"
      ? value.senderName.trim().slice(0, 100)
      : "";
    const context = [
      `Contact first name: ${String(contact.firstName || "there")}`,
      `Company: ${String(company?.name || "Not specified")}`,
      `Related opportunity: ${String(opportunity?.title || "Not specified")}`,
      `Sender name: ${senderName || "Not specified"}`,
      `Additional instructions: ${instructions || "Interpret the conversation and respond naturally to the latest message."}`,
      `Recent conversation messages (oldest first):\n${JSON.stringify(recentMessages)}`,
    ].join("\n");
    const content = await this.groqCompletion(settings.apiKey, settings.model, [
      {
        role: "system",
        content: "Draft a concise, natural email reply based on the conversation. Carefully interpret the latest received message and answer its questions or requests when possible. Preserve context from earlier messages, do not invent facts or claim actions that were not agreed, and do not include a subject or explanation. Return only valid JSON with exactly one string field: body.",
      },
      { role: "user", content: context },
    ], 1200);
    let draft: unknown;
    try { draft = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim()); } catch {
      throw new ServiceUnavailableException("Groq returned an invalid reply draft. Try again.");
    }
    if (!isRecord(draft) || typeof draft.body !== "string" || !draft.body.trim()) {
      throw new ServiceUnavailableException("Groq returned an empty reply draft. Try again.");
    }
    return { body: draft.body.trim().slice(0, 40000), model: settings.model };
  }

  async saveCalendarWebhookSecret(userId: string, value: unknown) {
    if (!isRecord(value) || typeof value.secret !== "string" || value.secret.trim().length < 32) {
      throw new BadRequestException("Enter the Cal.com webhook secret (at least 32 characters).");
    }
    const encryptedSecret = this.encrypt(value.secret.trim());
    if (!this.storage) {
      this.volatileCalendarSecrets.set(userId, encryptedSecret);
      return { configured: true };
    }
    const { error } = await this.storage.from("crm_cal_webhook_configs").upsert({
      user_id: userId, webhook_secret_encrypted: encryptedSecret, updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (error) throw new ServiceUnavailableException("Could not save the Cal.com webhook secret.");
    return { configured: true };
  }

  async processCalWebhook(userId: string, rawBody: string, signature: string) {
    if (!rawBody || !signature) throw new UnauthorizedException("The Cal.com webhook signature is missing.");
    let encryptedSecret: string | undefined;
    if (!this.storage) encryptedSecret = this.volatileCalendarSecrets.get(userId);
    else {
      const { data, error } = await this.storage.from("crm_cal_webhook_configs")
        .select("webhook_secret_encrypted").eq("user_id", userId).maybeSingle();
      if (error) throw new ServiceUnavailableException("Could not load the Cal.com webhook configuration.");
      encryptedSecret = data?.webhook_secret_encrypted;
    }
    if (!encryptedSecret) throw new UnauthorizedException("Cal.com webhooks are not configured for this workspace.");
    const expected = createHmac("sha256", this.decrypt(encryptedSecret)).update(rawBody).digest();
    const received = Buffer.from(signature.replace(/^sha256=/i, ""), "hex");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new UnauthorizedException("The Cal.com webhook signature is invalid.");
    }
    let event: Record<string, unknown>;
    try { event = JSON.parse(rawBody) as Record<string, unknown>; }
    catch { throw new BadRequestException("The Cal.com webhook body is not valid JSON."); }
    const trigger = String(event.triggerEvent || "").toUpperCase();
    const payload = isRecord(event.payload) ? event.payload : event;
    const uid = String(payload.uid || "");
    if (!uid) return { received: true, processed: false, reason: "booking UID missing" };
    if (trigger !== "BOOKING_CREATED" && trigger !== "BOOKING_RESCHEDULED" && trigger !== "BOOKING_CANCELLED" && trigger !== "BOOKING_REJECTED") {
      return { received: true, processed: false, reason: "unsupported booking event" };
    }
    const now = new Date().toISOString();
    if (trigger === "BOOKING_CANCELLED" || trigger === "BOOKING_REJECTED") {
      await this.updateCalendarMeetingStatus(userId, uid, "cancelled");
      return { received: true, processed: true };
    }
    const attendees = Array.isArray(payload.attendees) ? payload.attendees.filter(isRecord) : [];
    const primary = attendees[0] || {};
    const email = String(primary.email || "").trim().toLowerCase();
    const contactName = [primary.firstName, primary.lastName].filter((part) => typeof part === "string" && part).join(" ")
      || String(primary.name || "");
    const startTime = String(payload.startTime || "");
    const endTime = String(payload.endTime || "");
    if (!email || !startTime || !endTime || !Number.isFinite(Date.parse(startTime)) || !Number.isFinite(Date.parse(endTime))) {
      throw new BadRequestException("The Cal.com booking is missing a valid attendee email or meeting time.");
    }
    const workspace = await this.workspaceService.getWorkspace(userId);
    const matchedContact = workspace.data.contacts.find((contact) => String(contact.email || "").trim().toLowerCase() === email);
    const contactId = matchedContact ? String(matchedContact.id) : null;
    const locationValue = payload.location;
    const videoCallData = isRecord(payload.videoCallData) ? payload.videoCallData : {};
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    const linkCandidate = [videoCallData.url, metadata.videoCallUrl, locationValue]
      .find((value): value is string => typeof value === "string" && /^https?:\/\//i.test(value));
    let meetingUrl: string | null = null;
    if (linkCandidate) {
      try {
        const parsed = new URL(linkCandidate);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") meetingUrl = parsed.toString();
      } catch {
        meetingUrl = null;
      }
    }
    const location = meetingUrl || (typeof locationValue === "string" && !locationValue.startsWith("integrations:") ? locationValue : null);
    const rescheduleUid = String(payload.rescheduleUid || "");
    if (rescheduleUid && rescheduleUid !== uid) await this.updateCalendarMeetingStatus(userId, rescheduleUid, "rescheduled");
    await this.saveCalendarMeeting({
      user_id: userId, cal_uid: uid, contact_id: contactId, title: String(payload.title || "Cal.com meeting"),
      attendee_name: contactName, attendee_email: email, start_time: startTime, end_time: endTime,
      location, status: "booked", created_at: now, updated_at: now,
    });
    return { received: true, processed: true };
  }

  private async saveCalendarMeeting(row: CalendarMeetingRow) {
    if (!this.storage) {
      const meetings = this.volatileMeetings.get(row.user_id) || [];
      const index = meetings.findIndex((item) => item.cal_uid === row.cal_uid);
      if (index >= 0) meetings[index] = { ...meetings[index], ...row, created_at: meetings[index].created_at };
      else meetings.push(row);
      this.volatileMeetings.set(row.user_id, meetings);
      return;
    }
    const { error } = await this.storage.from("crm_calendar_bookings").upsert(row, { onConflict: "user_id,cal_uid" });
    if (error) throw new ServiceUnavailableException("Could not save the Cal.com booking.");
  }

  private async updateCalendarMeetingStatus(userId: string, uid: string, status: CalendarMeetingRow["status"]) {
    if (!this.storage) {
      const existing = (this.volatileMeetings.get(userId) || []).find((item) => item.cal_uid === uid);
      if (existing) {
        existing.status = status;
        existing.updated_at = new Date().toISOString();
      }
      return;
    }
    const { error } = await this.storage.from("crm_calendar_bookings")
      .update({ status, updated_at: new Date().toISOString() }).eq("user_id", userId).eq("cal_uid", uid);
    if (error) throw new ServiceUnavailableException("Could not update the rescheduled Cal.com booking.");
  }

  async getStats(userId: string) {
    const rows = await this.getRows(userId);
    const sent = rows.filter((row) => ["sent", "accepted", "delivered", "replied", "bounced", "complained"].includes(row.status)).length;
    const replies = rows.filter((row) => Boolean(row.replied_at)).length;
    let opened = 0;
    if (this.storage) {
      const { count } = await this.storage.from("crm_email_events").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("event_type", "opened");
      opened = count || 0;
    } else opened = this.volatileEvents.filter((event) => event.user_id === userId && event.event_type === "opened").length;
    return {
      sent, replies, replyRate: sent ? Math.round(replies / sent * 1000) / 10 : 0,
      clicks: rows.reduce((sum, row) => sum + (Number(row.click_count) || 0), 0),
      delivered: rows.filter((row) => row.status === "delivered").length,
      bounced: rows.filter((row) => row.status === "bounced").length,
      opened,
    };
  }

  private async saveLinks(links: ClickLink[]) {
    if (!links.length) return;
    if (!this.storage) { links.forEach((link) => this.volatileLinks.set(link.token, link)); return; }
    const { error } = await this.storage.from("crm_outreach_links").insert(links);
    if (error) throw new ServiceUnavailableException("Could not prepare click tracking for this email.");
  }

  private async removeLinks(userId: string, messageId: string) {
    if (!this.storage) {
      for (const [token, link] of this.volatileLinks) if (link.user_id === userId && link.message_id === messageId) this.volatileLinks.delete(token);
      return;
    }
    await this.storage.from("crm_outreach_links").delete().eq("user_id", userId).eq("message_id", messageId);
  }

  async recordClick(token: string) {
    let targetUrl = "";
    if (!this.storage) {
      const link = this.volatileLinks.get(token);
      if (!link) throw new NotFoundException("This tracked link was not found.");
      link.click_count += 1;
      const messages = this.volatileMessages.get(link.user_id) || [];
      const message = messages.find((item) => item.id === link.message_id);
      if (message) {
        message.click_count += 1;
        this.volatileEvents.push({
          user_id: link.user_id, message_id: message.id, provider: message.provider,
          provider_message_id: message.provider_message_id, sender_account: message.sender_account,
          event_type: "clicked", event_timestamp: new Date().toISOString(),
          provider_event_id: `tracked-link:${token}:${link.click_count}`,
          details: {}, processing_status: "processed", event_source: "internal_tracking",
        });
      }
      targetUrl = link.target_url;
    } else {
      const { data, error } = await this.storage.rpc("record_outreach_click", { p_token: token });
      if (error) throw new ServiceUnavailableException("Could not record this link click.");
      const entry = Array.isArray(data) ? data[0] : data;
      targetUrl = typeof entry === "string" ? entry : entry?.target_url || "";
      if (!targetUrl) throw new NotFoundException("This tracked link was not found.");
    }
    let safeUrl: URL;
    try { safeUrl = new URL(targetUrl); } catch { throw new NotFoundException("This tracked link is invalid."); }
    if (!['http:', 'https:'].includes(safeUrl.protocol)) throw new NotFoundException("This tracked link is invalid.");
    return safeUrl.toString();
  }

  private renderHtml(body: string, userId: string, messageId: string, links: ClickLink[]) {
    const parts = body.replace(/\r\n/g, "\n").split("\n");
    return parts.map((line) => {
      const chunks: string[] = [];
      const pattern = /(https?:\/\/[^\s<>"']+)/gi;
      let last = 0;
      for (const match of line.matchAll(pattern)) {
        const whole = match[0];
        const index = match.index ?? 0;
        const trailing = whole.match(/[),.;!?]+$/)?.[0] || "";
        const destination = trailing ? whole.slice(0, -trailing.length) : whole;
        chunks.push(escapeHtml(line.slice(last, index)));
        try {
          const parsed = new URL(destination);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid link");
          const token = randomBytes(24).toString("hex");
          links.push({ token, user_id: userId, message_id: messageId, target_url: parsed.toString(), click_count: 0 });
          chunks.push(`<a href="${escapeHtml(this.publicApiBase + "/outreach/click/" + token)}">${escapeHtml(destination)}</a>${escapeHtml(trailing)}`);
        } catch { chunks.push(escapeHtml(whole)); }
        last = index + whole.length;
      }
      chunks.push(escapeHtml(line.slice(last)));
      return chunks.join("") || "<br>";
    }).map((line) => `<div>${line}</div>`).join("");
  }

  async sendMessage(userId: string, value: unknown, threading?: { threadId?: string; inReplyTo?: string; references?: string; conversationId?: string }) {
    if (!isRecord(value) || typeof value.contactId !== "string" || typeof value.subject !== "string" || typeof value.body !== "string") throw new BadRequestException("Choose a contact and enter an email subject and message.");
    if (await this.isSendingPaused(userId)) throw new ConflictException("Outbound sending is paused for this workspace. Resume sending in Email Providers settings to continue.");
    const contactId = value.contactId.trim();
    const opportunityId = typeof value.opportunityId === "string" && value.opportunityId ? value.opportunityId : null;
    const idempotencyKey = typeof value.idempotencyKey === "string" ? value.idempotencyKey.trim() : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new BadRequestException("The send request is missing a valid idempotency key. Reopen the composer and try again.");
    const workspace = await this.workspaceService.getWorkspace(userId);
    const contact = workspace.data.contacts.find((item) => item.id === contactId && !item.archived);
    if (!contact || typeof contact.email !== "string" || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contact.email.trim())) throw new BadRequestException("This contact does not have a valid email address.");
    const opportunity = opportunityId ? workspace.data.opportunities.find((item) => item.id === opportunityId && !item.archived) : undefined;
    if (opportunityId && !opportunity) throw new BadRequestException("Choose an opportunity from this workspace.");
    const selectedProvider = value.provider ? providerId(value.provider) : await this.getDefaultProvider(userId);
    const defaultProvider = await this.getDefaultProvider(userId);
    const settings = await this.providerStatus(userId, selectedProvider, defaultProvider);
    if (!settings.eligibleForSending) throw new BadRequestException(`${settings.name} is not configured, verified, and active. Open Email Providers settings to check its status.`);
    if (selectedProvider === "resend" && value.recipientOptedIn !== true) throw new BadRequestException("Resend may only send to recipients who explicitly opted in. Confirm opt-in for this recipient or choose another provider.");
    if (value.subject.length > 998 || value.body.length > 40_000 || !value.subject.trim() || !value.body.trim()) throw new BadRequestException("The subject or message is empty or too long.");
    const recipient = contact.email.trim();
    if (/[\r\n]/.test(recipient) || /[\r\n]/.test(value.subject)) throw new BadRequestException("Email addresses and subjects must not contain line breaks.");
    if (await this.isSuppressed(userId, recipient)) throw new ConflictException("This address is on the workspace suppression list and cannot receive further outreach until the suppression is reviewed.");
    const company = String(workspace.data.companies.find((item) => item.id === contact.companyId)?.name || "your team");
    const senderName = typeof value.senderName === "string" && value.senderName.trim()
      ? value.senderName.trim().slice(0, 100)
      : settings.senderEmail.split("@")[0].replace(/[._-]+/g, " ");
    const fields = {
      firstName: String(contact.firstName || "there"), lastName: String(contact.lastName || ""),
      fullName: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(), company,
      opportunity: String(opportunity?.title || "a potential project"), senderName,
    };
    const subject = mergeFields(value.subject.trim(), fields).trim();
    const renderedBody = mergeFields(value.body, fields).trim();
    const id = idempotencyKey;
    const duplicateCheckSince = Date.now() - 60 * 60 * 1000;
    const unresolvedDuplicate = (await this.getRows(userId)).find((row) => row.id !== id
      && row.status === "sending" && row.recipient.toLowerCase() === recipient.toLowerCase()
      && row.subject === subject && row.body === renderedBody
      && new Date(row.created_at || 0).getTime() >= duplicateCheckSince);
    if (unresolvedDuplicate) throw new ConflictException("An identical email has an unresolved send attempt. Check provider send history before creating another attempt.");
    const config = await this.resolvedProviderConfig(userId, selectedProvider);
    if (selectedProvider === "gmail") config.accessToken = await this.getAccessToken(userId);
    if (emailProviders[selectedProvider].validate(config).length) throw new BadRequestException(`${settings.name} is missing required sending configuration.`);
    const row: MessageRow = {
      id, user_id: userId, contact_id: contactId, opportunity_id: opportunityId,
      recipient, recipient_name: `${String(contact.firstName || "")} ${String(contact.lastName || "")}`.trim(),
      subject, body: renderedBody, status: "sending", sent_at: null, replied_at: null,
      gmail_message_id: null, gmail_thread_id: null,
      provider: selectedProvider, sender_account: settings.senderEmail,
      provider_message_id: null, provider_thread_id: null,
      provider_capabilities: settings.capabilities, idempotency_key: idempotencyKey,
      recipient_opted_in: selectedProvider === "resend" && value.recipientOptedIn === true,
      created_at: new Date().toISOString(),
      click_count: 0,
    };
    const created = await this.createSendingMessage(row);
    if (!created.created) {
      if (["sent", "accepted", "delivered", "replied", "bounced", "complained"].includes(created.row.status)) return this.toMessage(created.row);
      if (created.row.status === "sending") throw new ConflictException("This message has an unresolved send attempt. Check the provider mailbox and outreach history before trying again.");
      throw new ConflictException("This send attempt already failed and cannot be retried with the same request key. Reopen the composer to create a new, explicit attempt.");
    }
    const links: ClickLink[] = [];
    let acceptedByProvider = false;
    let providerRequestStarted = false;
    try {
      const htmlBody = this.renderHtml(renderedBody, userId, id, links);
      await this.saveLinks(links);
      const account = await this.getStoredAccount(userId);
      providerRequestStarted = true;
      const result = await emailProviders[selectedProvider].send(config, {
        id, recipient, subject, html: htmlBody, senderName,
        ...(selectedProvider === "gmail" && threading?.threadId ? { threadId: threading.threadId } : {}),
        ...(selectedProvider === "gmail" && threading?.inReplyTo ? { inReplyTo: threading.inReplyTo } : {}),
        ...(selectedProvider === "gmail" && threading?.references ? { references: threading.references } : {}),
        ...(selectedProvider !== "gmail" && account?.email_address ? { replyTo: account.email_address } : {}),
      });
      acceptedByProvider = true;
      await this.recordProviderOperation(userId, selectedProvider, config);
      row.status = selectedProvider === "gmail" ? "sent" : "accepted";
      row.sent_at = result.acceptedAt;
      row.provider_message_id = result.providerMessageId;
      row.provider_thread_id = result.providerThreadId || (threading?.conversationId ? `crm-thread:${threading.conversationId.replace(/^crm-thread:/, "")}` : null);
      if (selectedProvider === "gmail") {
        row.gmail_message_id = result.providerMessageId;
        row.gmail_thread_id = result.providerThreadId || null;
      }
      await this.saveMessage(row);
      await this.recordEmailEvent({
        user_id: userId, message_id: id, provider: selectedProvider,
        provider_message_id: result.providerMessageId, sender_account: row.sender_account,
        event_type: selectedProvider === "gmail" ? "sent" : "provider_accepted",
        event_timestamp: result.acceptedAt, provider_event_id: `accept:${selectedProvider}:${id}`,
        details: {}, processing_status: "processed", event_source: "provider_api",
      }, false);
      return this.toMessage(row);
    } catch (error) {
      if (acceptedByProvider) throw new ServiceUnavailableException(`${settings.name} accepted this email, but the CRM could not save its tracking record. Check the provider's sent history before trying again.`);
      if (providerRequestStarted) await this.recordProviderOperation(userId, selectedProvider, config, error);
      const statusCode = statusCodeOf(error);
      if (!providerRequestStarted || statusCode) {
        row.status = "failed";
        await this.saveMessage(row).catch(() => undefined);
        await this.removeLinks(userId, id);
      }
      if (error instanceof BadRequestException || error instanceof ServiceUnavailableException || error instanceof BadGatewayException) throw error;
      if (error instanceof ConflictException) throw error;
      if (!statusCode) throw new ServiceUnavailableException("The provider request outcome is unknown. The CRM will not retry automatically; check provider send history before creating a new attempt.");
      const message = this.safeProviderError(error, config).slice(0, 300);
      throw new BadGatewayException(`${settings.name} rejected the email: ${message}`);
    }
  }

  private async providerEventTarget(userId: string, provider: EmailProviderId, eventData: Record<string, unknown>) {
    const tags = eventData.tags;
    let messageId = "";
    if (isRecord(tags)) {
      const tagged = tags.crmMessageId ?? tags.crm_message_id;
      messageId = Array.isArray(tagged) ? String(tagged[0] || "") : String(tagged || "");
    } else if (Array.isArray(tags)) {
      const tagged = tags.find((item) => isRecord(item) && item.name === "crmMessageId");
      if (isRecord(tagged)) messageId = String(tagged.value || "");
    }
    const providerMessageId = String(eventData.email_id || eventData.messageId || eventData.id || "") || null;
    const timestamp = String(eventData.created_at || eventData.timestamp || new Date().toISOString());
    return { messageId: messageId || null, providerMessageId, timestamp };
  }

  async processResendWebhook(userId: string, rawBody: string, headers: { id?: string; timestamp?: string; signature?: string }) {
    const config = await this.resolvedProviderConfig(userId, "resend");
    if (!config.apiKey || !config.webhookSecret) throw new UnauthorizedException("This Resend webhook is not configured.");
    if (!rawBody || !headers.id || !headers.timestamp || !headers.signature) throw new UnauthorizedException("The Resend webhook signature headers are incomplete.");
    let event: Record<string, unknown>;
    try {
      event = new Resend(config.apiKey).webhooks.verify({
        payload: rawBody,
        headers: { id: headers.id, timestamp: headers.timestamp, signature: headers.signature },
        webhookSecret: config.webhookSecret,
      }) as unknown as Record<string, unknown>;
    } catch { throw new UnauthorizedException("Resend webhook signature verification failed."); }
    const type = String(event.type || "");
    const data = isRecord(event.data) ? event.data : {};
    const target = await this.providerEventTarget(userId, "resend", data);
    if (type === "contact.updated" && isRecord(data) && (data.unsubscribed === true || data.status === "unsubscribed")) {
      const email = String(data.email || "");
      if (email) await this.suppressEmail(userId, email, "unsubscribe", "resend", headers.id);
      const result = await this.recordEmailEvent({
        user_id: userId, message_id: null, provider: "resend", provider_message_id: null,
        sender_account: config.senderEmail, event_type: "unsubscribed",
        event_timestamp: String(event.created_at || new Date().toISOString()), provider_event_id: headers.id,
        details: { contactId: String(data.id || ""), recipient: email }, processing_status: "processed", event_source: "resend_webhook",
      }, false);
      return { received: true, processed: result.processed };
    }
    const eventType = normalizeResendEventType(type);
    if (!eventType) return { received: true, processed: false, reason: "unsupported event" };
    const details: Record<string, unknown> = {};
    if (isRecord(data.bounce)) details.bounce = { type: data.bounce.type, subType: data.bounce.subType, message: data.bounce.message };
    if (Array.isArray(data.to) && typeof data.to[0] === "string") details.recipient = data.to[0];
    else if (typeof data.to === "string") details.recipient = data.to;
    const result = await this.recordEmailEvent({
      user_id: userId, message_id: target.messageId, provider: "resend",
      provider_message_id: target.providerMessageId, sender_account: config.senderEmail,
      event_type: eventType, event_timestamp: target.timestamp, provider_event_id: headers.id,
      details, processing_status: "processed", event_source: "resend_webhook",
    });
    return { received: true, processed: result.processed };
  }

  private snsCanonicalMessage(envelope: Record<string, unknown>) {
    const type = String(envelope.Type || "");
    const keys = type === "Notification"
      ? ["Message", "MessageId", ...(envelope.Subject ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
    return keys.map((key) => `${key}\n${String(envelope[key] || "")}\n`).join("");
  }

  private async verifySnsEnvelope(envelope: Record<string, unknown>) {
    const certUrl = String(envelope.SigningCertURL || "");
    let url: URL;
    try { url = new URL(certUrl); } catch { throw new UnauthorizedException("The Amazon SNS certificate URL is invalid."); }
    if (url.protocol !== "https:" || !/^sns\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/i.test(url.hostname) || !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname) || url.port) {
      throw new UnauthorizedException("The Amazon SNS certificate URL is not trusted.");
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new UnauthorizedException("Could not verify the Amazon SNS notification signature.");
    const certificate = await response.text();
    const algorithm = String(envelope.SignatureVersion) === "1" ? "RSA-SHA1" : String(envelope.SignatureVersion) === "2" ? "RSA-SHA256" : "";
    if (!algorithm) throw new UnauthorizedException("The Amazon SNS signature version is not supported.");
    const verifier = createVerify(algorithm);
    verifier.update(this.snsCanonicalMessage(envelope), "utf8");
    verifier.end();
    if (!verifier.verify(certificate, Buffer.from(String(envelope.Signature || ""), "base64"))) throw new UnauthorizedException("Amazon SNS notification signature verification failed.");
  }

  async processSesWebhook(userId: string, rawBody: string) {
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(rawBody) as Record<string, unknown>; }
    catch { throw new BadRequestException("The Amazon SNS request body is not valid JSON."); }
    await this.verifySnsEnvelope(envelope);
    const config = await this.resolvedProviderConfig(userId, "ses");
    const row = await this.getProviderConfigRow(userId, "ses");
    const topicArn = String(envelope.TopicArn || "");
    if (!row?.health?.topicArns?.length) throw new BadRequestException("Test the SES configuration-set event destination before sending SNS notifications to this endpoint.");
    if (!row.health.topicArns.includes(topicArn)) throw new UnauthorizedException("This Amazon SNS topic is not configured for the SES provider account.");
    if (envelope.Type === "SubscriptionConfirmation") {
      const token = String(envelope.Token || "");
      if (!token || !config.region) throw new BadRequestException("The Amazon SNS subscription confirmation is incomplete.");
      const client = new SNSClient({
        region: config.region,
        ...(config.accessKeyId && config.secretAccessKey ? { credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } } : {}),
      });
      await client.send(new ConfirmSubscriptionCommand({ TopicArn: topicArn, Token: token }));
      await this.persistProviderConfigRow({ ...row, health: { ...row.health, snsSubscriptionConfirmedAt: new Date().toISOString() } });
      return { received: true, subscribed: true };
    }
    if (envelope.Type !== "Notification") return { received: true, processed: false, reason: "unsupported SNS message type" };
    let sesEvent: Record<string, unknown>;
    try { sesEvent = JSON.parse(String(envelope.Message || "")) as Record<string, unknown>; }
    catch { throw new BadRequestException("The Amazon SES notification payload is not valid JSON."); }
    const eventType = String(sesEvent.eventType || sesEvent.notificationType || "");
    const normalizedType = normalizeSesEventType(eventType);
    if (!normalizedType) return { received: true, processed: false, reason: "unsupported SES event" };
    const mail = isRecord(sesEvent.mail) ? sesEvent.mail : {};
    const tags = isRecord(mail.tags) ? mail.tags : {};
    const rawMessageId = tags.crmMessageId;
    const messageId = Array.isArray(rawMessageId) ? String(rawMessageId[0] || "") : String(rawMessageId || "");
    const providerMessageId = String(mail.messageId || "") || null;
    const data = isRecord(sesEvent[eventType.toLowerCase()]) ? sesEvent[eventType.toLowerCase()] as Record<string, unknown> : {};
    const details: Record<string, unknown> = {};
    if (isRecord(data.bounce)) details.bounce = { type: data.bounce.bounceType, subType: data.bounce.bounceSubType, recipients: data.bounce.bouncedRecipients };
    const destinations = Array.isArray(mail.destination) ? mail.destination : [];
    if (typeof destinations[0] === "string") details.recipient = destinations[0];
    const bounced = isRecord(data.bounce) && Array.isArray(data.bounce.bouncedRecipients) ? data.bounce.bouncedRecipients : [];
    if (bounced.length) details.recipient = String((bounced[0] as Record<string, unknown>)?.emailAddress || details.recipient || "");
    if (isRecord(data.complaint)) details.complaint = { feedbackType: data.complaint.complaintFeedbackType };
    if (data.rejectReason) details.reason = data.rejectReason;
    if (data.smtpResponse) details.smtpResponse = data.smtpResponse;
    const timestamp = String(data.timestamp || mail.timestamp || envelope.Timestamp || new Date().toISOString());
    const result = await this.recordEmailEvent({
      user_id: userId, message_id: messageId || null, provider: "ses", provider_message_id: providerMessageId,
      sender_account: config.senderEmail, event_type: normalizedType, event_timestamp: timestamp,
      provider_event_id: String(envelope.MessageId || `${eventType}:${providerMessageId}:${timestamp}`),
      details, processing_status: "processed", event_source: "ses_sns",
    });
    return { received: true, processed: result.processed };
  }

  async syncReplies(userId: string) {
    const account = await this.getStoredAccount(userId);
    if (!account) throw new BadRequestException("Connect Gmail before checking for replies.");
    const accessToken = await this.getAccessToken(userId);
    const rows = await this.getRows(userId);
    const pending = rows.filter((row) => row.provider === "gmail" && (row.status === "sent" || row.status === "replied") && !row.replied_at && (row.provider_thread_id || row.gmail_thread_id) && row.sent_at);
    let replies = 0;
    for (const row of pending) {
      const threadId = row.provider_thread_id || row.gmail_thread_id!;
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`);
      url.searchParams.set("format", "metadata");
      url.searchParams.append("metadataHeaders", "From");
      url.searchParams.append("metadataHeaders", "Date");
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) continue;
      const thread = await response.json() as { messages?: GmailMessage[] };
      const sentAt = new Date(row.sent_at!).getTime();
      const replyDates = (thread.messages || []).filter((message) => {
        const fromHeader = message.payload?.headers?.find((header) => header.name?.toLowerCase() === "from")?.value || "";
        const address = fromHeader.match(/<([^>]+)>/)?.[1] || fromHeader;
        const receivedAt = Number(message.internalDate || 0);
        return address.trim().toLowerCase() === row.recipient.toLowerCase() && receivedAt > sentAt;
      }).map((message) => Number(message.internalDate || 0)).filter(Number.isFinite);
      if (!replyDates.length) continue;
      row.replied_at = new Date(Math.min(...replyDates)).toISOString();
      row.status = "replied";
      await this.saveMessage(row);
      await this.recordEmailEvent({
        user_id: userId, message_id: row.id, provider: "gmail", provider_message_id: row.provider_message_id,
        sender_account: account.email_address, event_type: "reply_received", event_timestamp: row.replied_at,
        provider_event_id: `gmail-reply:${threadId}:${row.replied_at}`, details: {},
        processing_status: "processed", event_source: "gmail_metadata",
      }, false);
      replies += 1;
    }
    const externalPending = rows.filter((row) => row.provider !== "gmail" && ["accepted", "sent", "delivered"].includes(row.status) && !row.replied_at && row.sent_at);
    let correlatedReplies = 0;
    if (externalPending.length) {
      let historyId = account.history_id || "";
      if (!historyId) {
        const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` } });
        const profile = await profileResponse.json().catch(() => ({})) as { historyId?: string };
        if (profileResponse.ok && profile.historyId) {
          account.history_id = profile.historyId;
          await this.saveAccount(account);
          historyId = profile.historyId;
        }
      }
      if (historyId) {
        let pageToken = "";
        let latestHistoryId = historyId;
        const messageIds: Array<{ id: string; threadId?: string }> = [];
        do {
          const historyUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/history");
          historyUrl.searchParams.set("startHistoryId", historyId);
          historyUrl.searchParams.set("historyTypes", "messageAdded");
          historyUrl.searchParams.set("maxResults", "500");
          if (pageToken) historyUrl.searchParams.set("pageToken", pageToken);
          const historyResponse = await fetch(historyUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (historyResponse.status === 404) {
            const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${accessToken}` } });
            const profile = await profileResponse.json().catch(() => ({})) as { historyId?: string };
            if (profileResponse.ok && profile.historyId) { account.history_id = profile.historyId; await this.saveAccount(account); }
            historyId = "";
            break;
          }
          if (!historyResponse.ok) break;
          const result = await historyResponse.json() as { history?: GmailHistoryItem[]; historyId?: string; nextPageToken?: string };
          latestHistoryId = result.historyId || latestHistoryId;
          for (const item of result.history || []) for (const added of item.messagesAdded || []) {
            if (added.message?.id) messageIds.push({ id: added.message.id, threadId: added.message.threadId });
          }
          pageToken = result.nextPageToken || "";
        } while (pageToken);

        for (const item of messageIds) {
          const messageUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}`);
          messageUrl.searchParams.set("format", "metadata");
          for (const name of ["From", "To", "Subject", "Date"]) messageUrl.searchParams.append("metadataHeaders", name);
          const response = await fetch(messageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
          if (!response.ok) continue;
          const received = await response.json() as GmailMessage & { id?: string; threadId?: string };
          const headers = headersOf(received);
          const from = addressOf(headers.from);
          const toAddresses = headers.to.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.map((address) => address.toLowerCase()) || [];
          const receivedAt = Number(received.internalDate || 0);
          if (from === account.email_address.toLowerCase() || !toAddresses.includes(account.email_address.toLowerCase()) || !receivedAt) continue;
          const candidates = externalPending.filter((row) => !row.replied_at
            && addressOf(row.recipient) === from
            && normalizedSubject(headers.subject) === normalizedSubject(row.subject)
            && receivedAt > new Date(row.sent_at!).getTime());
          if (!candidates.length) continue;
          const matching = candidates.sort((a, b) => new Date(b.sent_at!).getTime() - new Date(a.sent_at!).getTime())[0];
          matching.replied_at = new Date(receivedAt).toISOString();
          matching.status = "replied";
          matching.gmail_thread_id = received.threadId || item.threadId || null;
          await this.saveMessage(matching);
          await this.recordEmailEvent({
            user_id: userId, message_id: matching.id, provider: matching.provider,
            provider_message_id: matching.provider_message_id, sender_account: account.email_address,
            event_type: "reply_received", event_timestamp: matching.replied_at,
            provider_event_id: `gmail-reply:${item.id}`, details: { correlation: "sender_recipient_subject_headers" },
            processing_status: "processed", event_source: "gmail_metadata",
          }, false);
          correlatedReplies += 1;
        }
        if (historyId && latestHistoryId !== historyId) {
          account.history_id = latestHistoryId;
          await this.saveAccount(account);
        }
      }
    }
    return { checked: pending.length + externalPending.length, replies: replies + correlatedReplies, correlatedReplies };
  }
}
