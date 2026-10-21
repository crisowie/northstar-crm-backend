import { BadRequestException } from "@nestjs/common";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type SupportedVoiceCountry = "US" | "GB";

export type NormalizedVoiceNumber = {
  e164: string;
  country: SupportedVoiceCountry;
};

export function normalizeVoiceNumber(value: unknown, defaultCountry?: SupportedVoiceCountry): NormalizedVoiceNumber {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 64) {
    throw new BadRequestException("Enter a valid US or UK phone number.");
  }
  let parsed;
  try {
    parsed = parsePhoneNumberFromString(value.trim(), defaultCountry as CountryCode | undefined);
  } catch {
    parsed = undefined;
  }

  if (!parsed?.isValid() || parsed.ext || (parsed.country !== "US" && parsed.country !== "GB")) {
    throw new BadRequestException("Calling is currently limited to valid US (+1) and UK (+44) phone numbers.");
  }

  return { e164: parsed.number, country: parsed.country };
}

export function parseCallerId(value: unknown, expectedCountry: SupportedVoiceCountry): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = parsePhoneNumberFromString(value.trim());
    return parsed?.isValid() && parsed.country === expectedCountry ? parsed.number : null;
  } catch {
    return null;
  }
}
