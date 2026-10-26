import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Telnyx from "telnyx";
import { parsePhoneNumberFromString } from "libphonenumber-js";

export type SmsReadiness = {
  configured: boolean;
  status: "ready" | "not_configured";
  message: string;
  missing: string[];
  senderNumber: string | null;
};

export type SmsProviderResult = { id: string; status: string };

export interface SmsProvider {
  readiness(): SmsReadiness;
  send(destination: string, text: string): Promise<SmsProviderResult>;
}

@Injectable()
export class TelnyxSmsProvider implements SmsProvider {
  private clientInstance: Telnyx | null = null;

  constructor(private readonly config: ConfigService) {}

  private value(name: string): string {
    return (this.config.get<string>(name) || "").trim();
  }

  private sender(): string | null {
    const value = this.value("TELNYX_SMS_FROM_NUMBER") || this.value("TELNYX_PHONE_NUMBER");
    if (!value) return null;
    try {
      const parsed = parsePhoneNumberFromString(value);
      return parsed?.isValid() && (parsed.country === "US" || parsed.country === "GB") ? parsed.number : null;
    } catch {
      return null;
    }
  }

  readiness(): SmsReadiness {
    const senderNumber = this.sender();
    const missing: string[] = [];
    if (!this.value("TELNYX_API_KEY")) missing.push("TELNYX_API_KEY");
    if (!senderNumber) missing.push("TELNYX_SMS_FROM_NUMBER (or a valid TELNYX_PHONE_NUMBER)");
    const configured = missing.length === 0;
    return {
      configured,
      status: configured ? "ready" : "not_configured",
      message: configured
        ? "SMS settings are present. Telnyx account permissions, number registration, and destination support are verified when a message is sent."
        : "SMS is not enabled yet. Configure the Telnyx API key and an authorized SMS-capable sender number on the backend.",
      missing,
      senderNumber,
    };
  }

  private api(): Telnyx {
    const apiKey = this.value("TELNYX_API_KEY");
    if (!apiKey) throw new Error("Telnyx is not configured.");
    if (!this.clientInstance) {
      this.clientInstance = new Telnyx({
        apiKey,
        timeout: 15_000,
        maxRetries: 1,
        logLevel: "error",
      });
    }
    return this.clientInstance;
  }

  async send(destination: string, text: string): Promise<SmsProviderResult> {
    const senderNumber = this.sender();
    if (!senderNumber) throw new Error("Telnyx SMS sender is not configured.");
    const response = await this.api().messages.sendLongCode({
      from: senderNumber,
      to: destination,
      text,
      type: "SMS",
      auto_detect: true,
    });
    const id = response.data?.id;
    if (!id) throw new Error("Telnyx did not return a message identifier.");
    return { id, status: response.data?.to?.[0]?.status || "queued" };
  }
}

export const SMS_PROVIDER = Symbol("SMS_PROVIDER");
