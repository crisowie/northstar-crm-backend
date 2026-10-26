import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { WorkspaceService } from "../workspace/workspace.service";
import { normalizeVoiceNumber } from "../voice/phone";
import { SMS_PROVIDER, type SmsProvider, type SmsReadiness } from "./sms-provider";

type SmsStatus = "sending" | "queued" | "sent" | "delivered" | "sending_failed" | "delivery_failed" | "delivery_unconfirmed" | "failed";
type SmsMessage = {
  id: string;
  userId: string;
  idempotencyKey: string;
  contactId: string;
  destination: string;
  senderNumber: string;
  body: string;
  providerMessageId: string | null;
  status: SmsStatus;
  failureReason: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const visibleStatuses = new Set<SmsStatus>(["queued", "sending", "sent", "delivered", "sending_failed", "delivery_failed", "delivery_unconfirmed"]);

function fromRow(row: Record<string, any>): SmsMessage {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    contactId: row.contact_id,
    destination: row.destination,
    senderNumber: row.sender_number,
    body: row.body,
    providerMessageId: row.provider_message_id || null,
    status: row.status,
    failureReason: row.failure_reason || null,
    sentAt: row.sent_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(message: SmsMessage) {
  return {
    id: message.id,
    user_id: message.userId,
    idempotency_key: message.idempotencyKey,
    contact_id: message.contactId,
    destination: message.destination,
    sender_number: message.senderNumber,
    body: message.body,
    provider_message_id: message.providerMessageId,
    status: message.status,
    failure_reason: message.failureReason,
    sent_at: message.sentAt,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  };
}

function safeMessage(message: SmsMessage) {
  return {
    id: message.id,
    contactId: message.contactId,
    destination: message.destination,
    senderNumber: message.senderNumber,
    body: message.body,
    providerMessageId: message.providerMessageId,
    status: message.status,
    failureReason: message.failureReason,
    sentAt: message.sentAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

@Injectable()
export class SmsService {
  private readonly storage: SupabaseClient | null;
  private readonly messages = new Map<string, SmsMessage>();
  private readonly sendTimes = new Map<string, number[]>();

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(SMS_PROVIDER) private readonly provider: SmsProvider,
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
  ) {
    const url = config.get<string>("SUPABASE_URL")?.trim();
    const serviceRoleKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    this.storage = url && serviceRoleKey
      ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
  }

  getConfig(): SmsReadiness {
    return this.provider.readiness();
  }

  private async enforceRateLimit(userId: string) {
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    if (this.storage) {
      const result = await this.storage.from("crm_sms_messages").select("id", { count: "exact", head: true })
        .eq("user_id", userId).gte("created_at", cutoff);
      if (result.error) throw new ServiceUnavailableException("SMS sending limits could not be checked. Try again shortly.");
      if ((result.count || 0) >= 20) throw new ConflictException("SMS sending limit reached. Try again later.");
      return;
    }
    const times = (this.sendTimes.get(userId) || []).filter((time) => time > Date.now() - 60 * 60_000);
    if (times.length >= 20) throw new ConflictException("SMS sending limit reached. Try again later.");
    times.push(Date.now());
    this.sendTimes.set(userId, times);
  }

  private async findByIdempotencyKey(userId: string, key: string): Promise<SmsMessage | null> {
    if (this.storage) {
      const result = await this.storage.from("crm_sms_messages").select("*")
        .eq("user_id", userId).eq("idempotency_key", key).maybeSingle();
      if (result.error) throw new ServiceUnavailableException("SMS history could not be checked.");
      return result.data ? fromRow(result.data) : null;
    }
    const found = [...this.messages.values()].find((message) => message.userId === userId && message.idempotencyKey === key);
    return found ? { ...found } : null;
  }

  private async persist(message: SmsMessage, insert = false) {
    message.updatedAt = new Date().toISOString();
    if (this.storage) {
      const result = insert
        ? await this.storage.from("crm_sms_messages").insert(toRow(message))
        : await this.storage.from("crm_sms_messages").update(toRow(message)).eq("id", message.id).eq("user_id", message.userId);
      if (result.error) throw new ServiceUnavailableException(insert ? "The SMS request could not be recorded." : "SMS status could not be saved.");
    } else this.messages.set(message.id, { ...message });
  }

  async listMessages(userId: string) {
    if (this.storage) {
      const result = await this.storage.from("crm_sms_messages").select("*").eq("user_id", userId)
        .order("created_at", { ascending: false }).limit(500);
      if (result.error) throw new ServiceUnavailableException("SMS history could not be loaded.");
      return { messages: (result.data || []).map((row) => safeMessage(fromRow(row))) };
    }
    return {
      messages: [...this.messages.values()]
        .filter((message) => message.userId === userId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 500)
        .map(safeMessage),
    };
  }

  async sendMessage(userId: string, body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("SMS details are required.");
    const input = body as Record<string, unknown>;
    if (input.consentConfirmed !== true) throw new BadRequestException("Confirm that the recipient consented to receive SMS before sending.");
    if (typeof input.contactId !== "string" || input.contactId.trim().length === 0 || input.contactId.length > 120) {
      throw new BadRequestException("Select a contact to receive the SMS.");
    }
    if (typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 1600) {
      throw new BadRequestException("SMS text must be between 1 and 1,600 characters.");
    }
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) throw new BadRequestException("A valid idempotency key is required.");

    const existing = await this.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { message: safeMessage(existing), duplicate: true };

    const readiness = this.provider.readiness();
    if (!readiness.configured || !readiness.senderNumber) {
      throw new ServiceUnavailableException("SMS is not configured. Ask an administrator to finish Telnyx SMS setup.");
    }

    const { data } = await this.workspace.getWorkspace(userId);
    const contact = data.contacts.find((item) => item.id === input.contactId && !item.archived);
    if (!contact) throw new NotFoundException("The selected contact was not found in your workspace.");
    const destination = normalizeVoiceNumber(contact.phone).e164;

    await this.enforceRateLimit(userId);
    if (!this.storage) {
      const duplicate = [...this.messages.values()].find((message) => message.userId === userId && message.idempotencyKey === idempotencyKey);
      if (duplicate) return { message: safeMessage(duplicate), duplicate: true };
    }
    const now = new Date().toISOString();
    const message: SmsMessage = {
      id: randomUUID(),
      userId,
      idempotencyKey,
      contactId: input.contactId,
      destination,
      senderNumber: readiness.senderNumber,
      body: input.text.trim(),
      providerMessageId: null,
      status: "sending",
      failureReason: null,
      sentAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.persist(message, true);
    } catch (error) {
      if (this.storage) {
        const duplicate = await this.findByIdempotencyKey(userId, idempotencyKey);
        if (duplicate) return { message: safeMessage(duplicate), duplicate: true };
      }
      throw error;
    }

    let result: Awaited<ReturnType<SmsProvider["send"]>>;
    try {
      result = await this.provider.send(destination, message.body);
    } catch {
      message.status = "failed";
      message.failureReason = "Telnyx did not accept the message. Check the sender number and account messaging configuration.";
      await this.persist(message);
      throw new ServiceUnavailableException(message.failureReason);
    }

    message.providerMessageId = result.id;
    message.status = visibleStatuses.has(result.status as SmsStatus) ? result.status as SmsStatus : "queued";
    message.sentAt = new Date().toISOString();
    await this.persist(message);
    return { message: safeMessage(message), duplicate: false };
  }
}
