# Telnyx browser calling

This feature adds contact and company calling, plus a global Calls workspace with a keypad and call history, to the separate Northstar frontend and NestJS API projects. The API issues a short-lived Telnyx browser JWT from a per-session telephony credential, then authorizes each destination and caller ID. A Telnyx WebRTC call is parked by the SIP credential connection; the signed `call.initiated` webhook is checked against the authorized call before the API dials the PSTN leg through the Voice API application. Signed answer and hangup events drive call state and server-side duration; linked calls also update the contact or company activity and follow-up task records. Browser tokens, Telnyx API keys, credential IDs, and call-control identifiers are not returned in CRM call-history responses. Recording is disabled.

The authenticated `GET /api/voice/calls` endpoint returns the signed-in user's 100 most recent calls, including calls made without a CRM record. Add `?contactId=<id>` or `?companyId=<id>` to show one contact's or company's calls. The global Calls page uses the unfiltered route; the keypad can match a contact or company by phone, link one manually, or leave the call unlinked. US and UK numbers are currently supported, with caller ID selected by the server.

The app uses the `/api` prefix. Webhook URL is derived from `PUBLIC_API_URL` and ends with `/voice/webhooks`. The API allows one active call per user and limits each user to 20 call attempts and 20 browser credential sessions per hour.

## Migration and rollback

Migration `supabase/migrations/008_telnyx_voice.sql` creates three voice tables and their indexes. Migration `009_voice_company_calls.sql` adds the optional company link and index to the call table; it preserves all existing contact calls. Neither migration changes CRM tables or authentication policies. The voice tables deny direct `anon` and `authenticated` access; the authenticated NestJS API uses its existing server-only Supabase service-role client.

Before changing production schema:

1. Confirm the production Supabase project and verify that migrations through `007_preserve_workspace_records.sql` are applied.
2. Create and verify a Supabase backup or export using the backup process for the project's plan. Keep the backup outside the API service filesystem.
3. Apply `008_telnyx_voice.sql` and then `009_voice_company_calls.sql` to a staging database. Verify the three voice tables, the `company_id` column and index, RLS flags, and service-role grants.
4. Apply both SQL files in order through the Supabase SQL Editor during a controlled deployment window. The application does not apply them automatically.

To roll the feature back in the app, set `TELNYX_PARK_OUTBOUND_CALLS=false` (or remove the Telnyx environment values) and redeploy. This disables token issuance while preserving call history. If the new schema must also be removed, export voice data first and run the following statements manually; they permanently delete voice sessions, call logs, and webhook deduplication records:

```sql
drop table if exists public.crm_voice_webhook_events;
drop table if exists public.crm_voice_calls;
drop table if exists public.crm_voice_sessions;
```

## Railway environment

Set these variables on the **backend service only**. Do not put any Telnyx variable in the Vite environment.

| Variable | Value |
| --- | --- |
| `TELNYX_API_KEY` | Server API key with the required telephony-credential and Call Control API access. |
| `TELNYX_SIP_CONNECTION_ID` | ID of the credential-based SIP connection used by the browser SDK. |
| `TELNYX_VOICE_APPLICATION_ID` | ID of the Call Control Voice API application used for the PSTN leg. |
| `TELNYX_PHONE_NUMBER` | Purchased and authorized US number in E.164 format, such as `+1…`. |
| `TELNYX_PHONE_NUMBER_UK` | Optional purchased and authorized UK number in E.164 format, such as `+44…`. Leave blank until available. |
| `TELNYX_PUBLIC_KEY` | Base64 Ed25519 public key from the Telnyx webhook configuration. |
| `TELNYX_PARK_OUTBOUND_CALLS` | Keep `false` until Park Outbound Calls is enabled on the SIP connection and the webhook is reachable; then set `true`. |
| `PUBLIC_API_URL` | Public backend base URL including `/api`; for this deployment use `https://northstar-crm-api-production.up.railway.app/api`. |

Keep the existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_MODE=supabase`, `ENCRYPTION_KEY`, `FRONTEND_ORIGIN`, and email-provider variables configured as they are for the current service. No `TELNYX_CONNECTION_ID` variable is used: the browser SIP connection and Call Control Voice Application have distinct IDs and settings.

The frontend service needs its existing `VITE_API_URL` set to the same public API base ending in `/api`; the Supabase URL and anon key remain frontend configuration. The current frontend and backend projects each include Render manifests, while the production API URL supplied for this task is Railway. Configure the listed variables in Railway's backend Variables screen; no Railway manifest is present in these repositories.

## Telnyx portal setup after purchasing a number

1. Complete Telnyx's account verification and billing setup. Add a payment method and fund the account.
2. Buy the US number. In **Voice → SIP Connections**, create a credential-based SIP connection for the browser SDK. Assign the US number to that connection, and record the connection ID for `TELNYX_SIP_CONNECTION_ID`.
3. Enable **Park Outbound Calls** on that SIP connection. This feature intentionally leaves calls disabled until the matching backend setting is `true`.
4. Create a **Voice API Application / Call Control Application** for the server-placed PSTN leg. Set its webhook URL to `https://northstar-crm-api-production.up.railway.app/api/voice/webhooks` and configure the call events used by the feature (`call.initiated`, `call.answered`, and `call.hangup`). Record the application ID for `TELNYX_VOICE_APPLICATION_ID`.
5. Set the SIP connection webhook URL to the same endpoint for the parked WebRTC leg's events. Select the matching call lifecycle events.
6. Associate the SIP connection and Voice API Application with an outbound voice profile. Allow US calls. Before adding a UK caller ID, buy/verify the UK number, set `TELNYX_PHONE_NUMBER_UK`, and allow UK destinations on the outbound profile.
7. In Telnyx, check the outbound voice profile's billing method, channel limit, destination rate cap, and daily spend limit. Leave call recording disabled.
8. Copy the webhook Ed25519 public key into `TELNYX_PUBLIC_KEY`. Set `TELNYX_PARK_OUTBOUND_CALLS=true` only after the connection feature is enabled and backend deployment is complete.
9. Redeploy the API. The startup log reports missing Telnyx setting names only; it does not print secret values. Apply migrations 008 and 009 before placing calls.

Portal labels can differ between accounts. Use the current SIP connection's outbound profile and the Call Control application's webhook settings; do not substitute a browser-provided caller ID or SIP password.

## Run and verify

Install the two projects separately from their respective roots:

```powershell
# API
npm ci
npm test
npm run build
npm run start:dev

# In a second terminal, from the frontend project
npm ci
npm run build
npm run dev
```

The API test suite mocks all Telnyx calls and signed-event verification. It never places a paid call. The frontend currently has no separate test or lint script; `npm run build` runs its TypeScript check and Vite production build. No test/lint scripts exist in the frontend package.

## Live call checklist

1. Apply migrations 008 and 009 after the backup/staging checks above and confirm the backend can load the voice tables and company link column.
2. Configure the Railway variables and Telnyx portal items above; verify the Telnyx account is paid/verified and the outbound profile allows US and UK destinations you plan to test.
3. Confirm the frontend is served over HTTPS and points to the Railway `/api` URL. For local development, `localhost` is a secure context for microphone access.
4. Sign in to Northstar and open **Calls** to enter a US/UK number on the keypad, optionally link a contact or company, and continue to the dialer; contact and company profiles also have a **Call** action. Press **Start call** in the dialer to grant microphone access.
5. Confirm the dialer moves through SDK-reported connecting/ringing/connected states. Speak and listen through the selected microphone/speakers, then end the call.
6. Wait for the signed server event to confirm the terminal status and duration. Review the entry in **Calls → Call history**, then save an outcome and optionally a note/follow-up date. For a linked call, verify one call activity and at most one follow-up task on the contact, then reload the page and confirm both records remain.
7. Confirm the Telnyx portal/CDRs show the expected parked WebRTC leg and PSTN leg. Check billing/rates before any additional call.

The source integration is built and mocked-provider tested, but it is not live-call verified. The account and number are not configured in this workspace. Telnyx may require account verification, a positive balance, country authorization on the outbound voice profile, a valid caller ID, and regional number documentation before a call can complete. Telnyx documents US/Canada as default outbound destinations on voice profiles; other destinations such as the UK need to be enabled, and some international calling may require Level 2 verification. See [Telnyx outbound call troubleshooting](https://support.telnyx.com/en/articles/5025298-troubleshooting-call-completion), [Outbound Voice Profiles](https://support.telnyx.com/en/articles/4320411-more-about-outbound-voice-profiles), and [Account Verification](https://support.telnyx.com/en/articles/1130595-account-verification).

Use a current desktop browser supported by Telnyx WebRTC (Chrome is documented for Windows/Linux/macOS) and serve production over HTTPS. Browser calling requires microphone permission and WebRTC network connectivity. Telnyx's [WebRTC quickstart](https://developers.telnyx.com/docs/development/webrtc/js-sdk/tutorials/make-your-first-call) documents JWT login and waiting for `telnyx.ready`; its [telephony-credential guide](https://developers.telnyx.com/docs/voice/webrtc/auth/telephony-credentials/index) advises waiting about five seconds before first registration when credentials are created on demand. The implementation follows both. Calls may incur number rental and per-minute charges; the CRM does not show a price estimate. Caller ID is the configured phone number, and no business caller-name registration is included.
