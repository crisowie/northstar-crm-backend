import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Telnyx from "telnyx";
import { parseCallerId, type SupportedVoiceCountry } from "./phone";

export type VoiceReadiness = {
  configured: boolean;
  status: "ready" | "not_configured";
  message: string;
  missing: string[];
  callerIds: Partial<Record<SupportedVoiceCountry, string>>;
};

export type WebhookHeaders = {
  "telnyx-signature-ed25519"?: string;
  "telnyx-timestamp"?: string;
};

export type TelnyxVoiceEvent = {
  data?: {
    id?: string;
    event_type?: string;
    occurred_at?: string;
    payload?: Record<string, unknown>;
  };
};

export type BrowserCredential = { id: string; username: string; expiresAt: string };
export type DialedCall = { callControlId: string };

export interface VoiceProvider {
  readiness(): VoiceReadiness;
  callerId(country: SupportedVoiceCountry): string | null;
  sipConnectionId(): string;
  voiceApplicationId(): string;
  webhookUrl(): string;
  issueBrowserCredential(): Promise<{ credential: BrowserCredential; token: string }>;
  deleteBrowserCredential(credentialId: string): Promise<void>;
  dialPstn(options: { destination: string; callerId: string; clientState: string; webhookUrl: string; commandId: string }): Promise<DialedCall>;
  bridge(firstCallControlId: string, secondCallControlId: string, commandId: string): Promise<void>;
  hangup(callControlId: string, commandId: string): Promise<void>;
  verifyWebhook(rawBody: string, headers: WebhookHeaders): Promise<TelnyxVoiceEvent>;
}

@Injectable()
export class TelnyxVoiceProvider implements VoiceProvider {
  private clientInstance: Telnyx | null = null;

  constructor(private readonly config: ConfigService) {}

  private value(name: string): string {
    return (this.config.get<string>(name) || "").trim();
  }

  readiness(): VoiceReadiness {
    const callerIds: VoiceReadiness["callerIds"] = {};
    const usCallerId = parseCallerId(this.value("TELNYX_PHONE_NUMBER"), "US");
    const ukRaw = this.value("TELNYX_PHONE_NUMBER_UK");
    const ukCallerId = parseCallerId(ukRaw, "GB");
    if (usCallerId) callerIds.US = usCallerId;
    if (ukCallerId) callerIds.GB = ukCallerId;

    const missing: string[] = [];
    for (const name of ["TELNYX_API_KEY", "TELNYX_SIP_CONNECTION_ID", "TELNYX_VOICE_APPLICATION_ID", "TELNYX_PUBLIC_KEY", "PUBLIC_API_URL"]) {
      if (!this.value(name)) missing.push(name);
    }
    if (!usCallerId) missing.push("TELNYX_PHONE_NUMBER (valid US +1 number required)");
    if (this.value("TELNYX_PARK_OUTBOUND_CALLS").toLowerCase() !== "true") missing.push("TELNYX_PARK_OUTBOUND_CALLS=true");

    const publicUrl = this.publicWebhookUrl();
    if (!publicUrl && !missing.includes("PUBLIC_API_URL")) missing.push("PUBLIC_API_URL (must be a valid API URL)");

    const configured = missing.length === 0;
    return {
      configured,
      status: configured ? "ready" : "not_configured",
      message: configured
        ? "Calling configuration is present. Telnyx account verification, outbound permissions, and browser compatibility are confirmed when a call is placed."
        : "Browser calling is not enabled yet. Complete the Telnyx settings shown below in the backend environment and Telnyx portal.",
      missing,
      callerIds,
    };
  }

  private publicWebhookUrl(): string | null {
    const raw = this.value("PUBLIC_API_URL");
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" && (this.config.get<string>("NODE_ENV") || process.env.NODE_ENV) === "production") return null;
      if (url.search || url.hash || url.username || url.password) return null;
      const path = url.pathname.replace(/\/+$/, "");
      url.pathname = (path.endsWith("/api") ? path : `${path}/api`) + "/voice/webhooks";
      return url.toString();
    } catch {
      return null;
    }
  }

  private api(): Telnyx {
    const apiKey = this.value("TELNYX_API_KEY");
    if (!apiKey) throw new Error("Telnyx is not configured.");
    if (!this.clientInstance) {
      this.clientInstance = new Telnyx({
        apiKey,
        publicKey: this.value("TELNYX_PUBLIC_KEY") || undefined,
        timeout: 15_000,
        maxRetries: 1,
        logLevel: "error",
      });
    }
    return this.clientInstance;
  }

  async issueBrowserCredential() {
    const connectionId = this.value("TELNYX_SIP_CONNECTION_ID");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const result = await this.api().telephonyCredentials.create({
      connection_id: connectionId,
      expires_at: expiresAt,
      name: "Northstar CRM browser session",
    });
    const credentialId = result.data?.id;
    const username = result.data?.sip_username;
    if (!credentialId || !username) throw new Error("Telnyx did not return a browser credential.");
    // Telnyx documents a short propagation delay for credentials created on demand.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const token = await this.api().telephonyCredentials.createToken(credentialId);
    if (typeof token !== "string" || token.length < 20) throw new Error("Telnyx did not return a browser token.");
    return { credential: { id: credentialId, username, expiresAt }, token };
  }

  async deleteBrowserCredential(credentialId: string) {
    await this.api().telephonyCredentials.delete(credentialId);
  }

  async dialPstn(options: { destination: string; callerId: string; clientState: string; webhookUrl: string; commandId: string }) {
    const result = await this.api().calls.dial({
      connection_id: this.value("TELNYX_VOICE_APPLICATION_ID"),
      to: options.destination,
      from: options.callerId,
      client_state: options.clientState,
      command_id: options.commandId,
      webhook_url: options.webhookUrl,
      webhook_url_method: "POST",
      time_limit_secs: 14_400,
    });
    const callControlId = result.data?.call_control_id;
    if (!callControlId) throw new Error("Telnyx did not return a call control identifier.");
    return { callControlId };
  }

  async bridge(firstCallControlId: string, secondCallControlId: string, commandId: string) {
    await this.api().calls.actions.bridge(firstCallControlId, {
      call_control_id_to_bridge_with: secondCallControlId,
      command_id: commandId,
    });
  }

  async hangup(callControlId: string, commandId: string) {
    await this.api().calls.actions.hangup(callControlId, { command_id: commandId });
  }

  async verifyWebhook(rawBody: string, headers: WebhookHeaders): Promise<TelnyxVoiceEvent> {
    const publicKey = this.value("TELNYX_PUBLIC_KEY");
    if (!publicKey || !headers["telnyx-signature-ed25519"] || !headers["telnyx-timestamp"]) {
      throw new Error("Telnyx webhook signature headers or public key are missing.");
    }
    const event = await this.api().webhooks.unwrap(rawBody, {
      headers: {
        "telnyx-signature-ed25519": headers["telnyx-signature-ed25519"],
        "telnyx-timestamp": headers["telnyx-timestamp"],
      },
      key: publicKey,
    });
    return event as TelnyxVoiceEvent;
  }

  callerId(country: SupportedVoiceCountry): string | null {
    return country === "US"
      ? parseCallerId(this.value("TELNYX_PHONE_NUMBER"), "US")
      : parseCallerId(this.value("TELNYX_PHONE_NUMBER_UK"), "GB");
  }

  webhookUrl(): string {
    return this.publicWebhookUrl() || "";
  }

  sipConnectionId(): string {
    return this.value("TELNYX_SIP_CONNECTION_ID");
  }

  voiceApplicationId(): string {
    return this.value("TELNYX_VOICE_APPLICATION_ID");
  }
}

export const VOICE_PROVIDER = Symbol("VOICE_PROVIDER");
