# Northstar outreach and CRM API

NestJS API for the Northstar CRM frontend. The frontend and API are separate projects; run the API from this directory.

## Local setup

```powershell
npm install
Copy-Item .env.example .env
npm run start:dev
```

The API listens on `http://localhost:5000/api`. Keep OAuth/API credentials in this API's environment only. Apply migrations `001_crm_workspaces.sql`, `002_crm_domain_tables.sql`, `003_gmail_outreach.sql`, `004_email_providers.sql`, and `005_cal_bookings.sql` in order if they have not already been applied. Migrations 004 and 005 are additive.

## Gmail mailbox

1. Enable the Gmail API in a Google Cloud project.
2. Configure a Google OAuth web client. Add `${PUBLIC_API_URL}/outreach/gmail/callback` as an authorized redirect URI.
3. Set `PUBLIC_API_URL` to the public API base URL including `/api`. Click tracking and webhooks require a reachable HTTPS URL in production.
4. Connect Gmail from Outreach or Email Providers settings.

The integration requests `gmail.send`, `gmail.metadata`, and `gmail.readonly`. It sends via Gmail, synchronizes replies from metadata headers, and loads full message bodies only when an authorized user opens an outreach thread. Gmail IDs are stored separately from normalized message and provider IDs. Messages sent through SES or Resend can be correlated to a Gmail reply when Gmail is connected, replies are addressed to that mailbox, and From/To/Subject headers identify the original conversation. This cross-provider match is header-based and can be ambiguous when the same recipient receives multiple messages with the same subject. Existing Gmail connections must be disconnected and re-authorized to grant read-only access; do not enable thread-content viewing unless the mailbox owner approves this broader access.

Google classifies `gmail.send` as sensitive, and `gmail.metadata` and `gmail.readonly` as restricted. Configure the OAuth consent screen and verification for the deployment and user audience. Thread bodies are fetched on demand, not copied into the CRM database. See [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Provider selection and credentials

The Email Providers settings page shows the provider's status, sender, verification, capabilities, last successful operation, and most recent provider error. Test a connection before activating it. The default provider is per workspace; an individual message can explicitly override that default. A send is attempted only through the selected provider: failures never switch providers automatically.

Server environment variables are fallback configuration for each provider. Encrypted per-workspace settings in Supabase take precedence for the same provider. The `ENCRYPTION_KEY` (or legacy `GMAIL_TOKEN_ENCRYPTION_KEY`) must remain stable and be a base64-encoded 32-byte key. Changing it makes existing encrypted Gmail tokens and provider credentials unreadable. Secrets are never returned by API settings endpoints.

Only the selected default provider's environment configuration is checked at startup; missing values are reported by variable name without printing secrets. Provider credentials can instead be entered in the authenticated settings page. Production requires Supabase storage and the encryption key; the in-memory fallback is for local development only.

| Provider | Sending | Inbox/replies | Events and limits |
| --- | --- | --- | --- |
| Gmail / Google Workspace | Gmail API | Gmail metadata thread sync | Gmail sends and replies; the CRM's tracked links record clicks. Gmail does not provide reliable delivery, bounce, or open events through this integration. |
| Amazon SES | SES API v2 | Separate mailbox needed; optional Gmail header correlation | Delivery, bounce, complaint, reject, open, and click events appear only when the SES configuration set and SNS event destination are configured. SES acceptance is not delivery confirmation. |
| Resend | Resend API | Separate mailbox needed; optional Gmail header correlation | Delivery, bounce, complaint, open, and click events arrive only for subscribed, verified webhook event types. The CRM's tracked links also record clicks. **Resend is opt-in only; its current Acceptable Use Policy prohibits unsolicited messages, including cold outreach.** |

Resend sends require a per-message explicit opt-in confirmation. The UI does not present Resend as an approved cold-prospecting provider. Do not use it for unsolicited client outreach. Its current policy requires explicit opt-in and disallows unsolicited recipients: [Resend Acceptable Use Policy](https://resend.com/legal/acceptable-use).

### Amazon SES setup

Set `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SES_FROM_EMAIL`, and optionally `AWS_SES_CONFIGURATION_SET` in the API environment, or save these values in Email Providers settings. Verify the sender address or domain in SES. Keep the account's IAM permissions limited to the SES and SNS operations needed by this integration.

For provider webhooks, create an SES configuration set with an SNS event destination and subscribe the SNS topic to the per-workspace webhook URL shown in Email Providers settings. Select the event types you want to track (send, delivery, bounce, complaint, reject, open, click). SNS subscription confirmation is verified and confirmed by the API. SES sandbox accounts can send only to verified recipients or the SES mailbox simulator; request SES production access before sending to arbitrary recipients. A successful SES response means accepted by SES, not delivered.

### Resend setup

Set `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and optionally `RESEND_WEBHOOK_SECRET` in the API environment, or enter them in Email Providers settings. Verify the sender domain in Resend. Create a webhook pointed at the displayed workspace webhook URL and subscribe to `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.opened`, and `email.clicked`. Copy its signing secret into settings. Webhooks use the original raw request body and Svix signature verification; duplicate event IDs are ignored.

## Email history and event semantics

The legacy Gmail message and thread IDs remain available alongside each message's internal ID, provider ID, sender account, and provider message/thread IDs. The normalized event table deduplicates provider webhooks. It distinguishes provider acceptance from delivery and records delivery only when the provider reports it. Open events are estimates; images may be blocked or cached. Clicks from tracked links are recorded by the CRM redirect. Historical click counters and URLs are preserved; there are no invented historical timestamps.

Each provider advertises its own sending, inbound synchronization, webhook, bounce, delivery, open, and click capabilities. SES/Resend do not gain inbox synchronization merely because they send email. When Gmail is connected, the API can correlate a received message by matching sender, recipient, normalized subject, and time headers; the settings UI describes this as a best-effort capability.

## Cal.com bookings

Open **Meetings** in the frontend and follow the Cal.com connection instructions. Create a Cal.com webhook with the per-workspace subscriber URL shown there; select `BOOKING_CREATED`, `BOOKING_CANCELLED`, and `BOOKING_RESCHEDULED` (and optionally `BOOKING_REJECTED`). Use a unique webhook secret of at least 32 characters in Cal.com and save the same secret in the CRM. The API encrypts the secret at rest and verifies Cal.com's `X-Cal-Signature-256` HMAC against the raw request body.

Cal.com must be able to reach the deployed API over public HTTPS. Booking records are stored in Supabase, associated to a CRM contact when attendee email matches, and shown on the Meetings page and dashboard. Link clicks are not used to infer bookings. Apply migration `005_cal_bookings.sql` before enabling the integration.

## Render deployment

This API project has its own `render.yaml`. It pins Node 24.21.0 for deployment; `package.json` declares the supported Node range. Deploy it as a **Web Service** from the API project/repository root and configure the secret values in Render. Deploy the frontend's separate `render.yaml` as a **Static Site** from the frontend project/repository root. Set `FRONTEND_ORIGIN` and `PUBLIC_API_URL` to the deployed HTTPS URLs, and set the frontend's `VITE_API_URL` to the API URL ending in `/api`. Add the API callback URL to Google OAuth.

Supabase remains the authoritative CRM store. Do not use local files, Render free Postgres, or free Key Value for authoritative data or OAuth credentials. Render free web services sleep after 15 minutes without inbound requests and can take about a minute to wake; their filesystems are ephemeral. Free Render Postgres expires after 30 days and has no backups, while free Key Value is in-memory and loses state on restart. These free services are suitable for a preview, not durable production storage. Make and test Supabase backups/restores separately.

The CRM sends a message synchronously when the user presses Send. It has no campaign scheduler or background worker; do not configure or advertise scheduled sends/follow-ups on the free tier. A message record is persisted before the provider request. If the request times out and acceptance is uncertain, the API leaves the message in `sending` and blocks the same idempotency key; check provider history before creating another attempt. Future scheduled campaigns need a durable database-backed queue and persistent worker before they are enabled.

Apply database migrations manually through the Supabase SQL editor in sequence, after checking the migrations already applied. Migrations 004 and 005 do not drop data. Store backups outside the API filesystem and document restoration steps for the selected Supabase plan.

## Commands

```powershell
npm run start:dev
npm run build
npm start
```
