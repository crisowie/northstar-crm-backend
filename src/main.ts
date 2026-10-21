import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { TelnyxVoiceProvider } from "./voice/voice-provider";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.useBodyParser("json", { limit: "10mb" });
  const config = app.get(ConfigService);
  const voiceProvider = app.get(TelnyxVoiceProvider);
  const voiceReadiness = voiceProvider.readiness();
  if (!voiceReadiness.configured) console.warn(`Telnyx browser calling is disabled until configured (${voiceReadiness.missing.join(", ")}). CRM startup will continue.`);
  const environment = config.get<string>("NODE_ENV") || process.env.NODE_ENV || "development";
  const defaultProvider = (config.get<string>("EMAIL_PROVIDER") || "gmail").trim().toLowerCase();
  if (!["gmail", "ses", "resend"].includes(defaultProvider)) throw new Error("EMAIL_PROVIDER must be gmail, ses, or resend.");
  const supabaseUrl = config.get<string>("SUPABASE_URL")?.trim();
  const serviceRoleKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (Boolean(supabaseUrl) !== Boolean(serviceRoleKey)) throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both empty for local development.");
  if (environment === "production" && (!supabaseUrl || !serviceRoleKey)) throw new Error("Production requires Supabase storage; volatile in-memory CRM storage is only for local development.");
  const encryptionKey = (config.get<string>("ENCRYPTION_KEY") || config.get<string>("GMAIL_TOKEN_ENCRYPTION_KEY") || "").trim();
  if (encryptionKey && Buffer.from(encryptionKey, "base64").length !== 32) throw new Error("ENCRYPTION_KEY or GMAIL_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  if (environment === "production" && !encryptionKey) throw new Error("Production requires ENCRYPTION_KEY (or GMAIL_TOKEN_ENCRYPTION_KEY) to encrypt connected-provider credentials.");
  const requiredByProvider: Record<string, string[]> = {
    gmail: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ses: ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SES_FROM_EMAIL"],
    resend: ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  };
  const missingDefaultConfig = (requiredByProvider[defaultProvider] || []).filter((key) => !config.get<string>(key)?.trim());
  if (defaultProvider === "gmail" && !encryptionKey) missingDefaultConfig.push("ENCRYPTION_KEY or GMAIL_TOKEN_ENCRYPTION_KEY");
  if (missingDefaultConfig.length) console.warn(`EMAIL_PROVIDER=${defaultProvider} has incomplete environment defaults (${missingDefaultConfig.join(", ")}). Add credentials in Email Providers settings or configure the missing server environment values.`);
  const allowedOrigins = (config.get<string>("FRONTEND_ORIGIN") || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.setGlobalPrefix("api");
  app.enableCors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  const port = Number(config.get<string>("PORT") || 5000);
  const host = config.get<string>("HOST") || (environment === "production" ? "0.0.0.0" : "127.0.0.1");
  await app.listen(port, host);
}

void bootstrap();
