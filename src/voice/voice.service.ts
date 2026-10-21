import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { WorkspaceService } from "../workspace/workspace.service";
import { normalizeVoiceNumber } from "./phone";
import { VOICE_PROVIDER, type TelnyxVoiceEvent, type VoiceProvider } from "./voice-provider";

const activeStatuses = ["authorized", "connecting", "dialing", "connected", "ending"];
const outcomes = ["No answer", "Busy", "Voicemail", "Connected — interested", "Connected — follow-up required", "Not interested", "Wrong number", "Other"] as const;
type VoiceStatus = "authorized" | "connecting" | "dialing" | "connected" | "ending" | "ended" | "failed" | "cancelled";
type VoiceCall = {
  id: string; userId: string; sessionId: string; contactId: string | null; companyId: string | null; idempotencyKey: string;
  destination: string; callerNumber: string; provider: "telnyx"; status: VoiceStatus;
  webrtcCallControlId: string | null; pstnCallControlId: string | null;
  startedAt: string; answeredAt: string | null; endedAt: string | null; durationSeconds: number | null;
  failureReason: string | null; outcome: string | null; note: string | null; followUpDate: string | null;
  followUpTaskId: string | null; endRequestedAt: string | null; createdAt: string; updatedAt: string;
};

function rowToCall(row: Record<string, any>): VoiceCall {
  return {
    id: row.id, userId: row.user_id, sessionId: row.session_id, contactId: row.contact_id || null, companyId: row.company_id || null,
    idempotencyKey: row.idempotency_key, destination: row.destination, callerNumber: row.caller_number,
    provider: "telnyx", status: row.status, webrtcCallControlId: row.webrtc_call_control_id || null,
    pstnCallControlId: row.pstn_call_control_id || null, startedAt: row.started_at,
    answeredAt: row.answered_at || null, endedAt: row.ended_at || null,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    failureReason: row.failure_reason || null, outcome: row.outcome || null, note: row.note || null,
    followUpDate: row.follow_up_date || null, followUpTaskId: row.follow_up_task_id || null,
    endRequestedAt: row.end_requested_at || null, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function callToRow(call: VoiceCall) {
  return {
    id: call.id, user_id: call.userId, session_id: call.sessionId, contact_id: call.contactId, company_id: call.companyId,
    idempotency_key: call.idempotencyKey, destination: call.destination, caller_number: call.callerNumber,
    provider: call.provider, status: call.status, webrtc_call_control_id: call.webrtcCallControlId,
    pstn_call_control_id: call.pstnCallControlId, started_at: call.startedAt, answered_at: call.answeredAt,
    ended_at: call.endedAt, duration_seconds: call.durationSeconds, failure_reason: call.failureReason,
    outcome: call.outcome, note: call.note, follow_up_date: call.followUpDate,
    follow_up_task_id: call.followUpTaskId, end_requested_at: call.endRequestedAt,
    created_at: call.createdAt, updated_at: call.updatedAt,
  };
}

function fromClientState(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return typeof parsed === "string" && /^[0-9a-f-]{36}$/i.test(parsed) ? parsed : null;
  } catch { return null; }
}

function customHeaderCallId(payload: Record<string, unknown>): string | null {
  const headers = payload.custom_headers;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const headerName = typeof item.name === "string" ? item.name : item.header_name;
      const headerValue = typeof item.value === "string" ? item.value : item.header_value;
      if (typeof headerName === "string" && headerName.toLowerCase() === "x-northstar-call-id" && typeof headerValue === "string") return headerValue;
    }
  }
  if (headers && typeof headers === "object") {
    const found = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === "x-northstar-call-id")?.[1];
    if (typeof found === "string") return found;
  }
  return null;
}

function correlationId(payload: Record<string, unknown>): string | null {
  const headerCallId = customHeaderCallId(payload);
  if (headerCallId) return headerCallId;
  const state = fromClientState(payload.client_state);
  if (state) return state;
  const rawState = payload.client_state;
  if (typeof rawState === "string" && /^[0-9a-f-]{36}$/i.test(rawState)) return rawState;
  return null;
}

function safeCall(call: VoiceCall) {
  return {
    id: call.id, contactId: call.contactId, companyId: call.companyId, destination: call.destination, callerId: call.callerNumber,
    provider: call.provider, status: call.status, startedAt: call.startedAt, answeredAt: call.answeredAt,
    endedAt: call.endedAt, durationSeconds: call.durationSeconds, failureReason: call.failureReason,
    outcome: call.outcome, note: call.note, followUpDate: call.followUpDate,
    createdAt: call.createdAt, updatedAt: call.updatedAt,
  };
}

@Injectable()
export class VoiceService {
  private readonly storage: SupabaseClient | null;
  private readonly calls = new Map<string, VoiceCall>();
  private readonly sessions = new Map<string, Record<string, any>>();
  private readonly webhookEvents = new Set<string>();
  private readonly tokenTimes = new Map<string, number[]>();
  private readonly callTimes = new Map<string, number[]>();

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(VOICE_PROVIDER) private readonly provider: VoiceProvider,
    @Inject(WorkspaceService) private readonly workspace: WorkspaceService,
  ) {
    const url = config.get<string>("SUPABASE_URL")?.trim();
    const serviceRoleKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    this.storage = url && serviceRoleKey
      ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
      : null;
  }

  getConfig() {
    const readiness = this.provider.readiness();
    return {
      configured: readiness.configured,
      status: readiness.status,
      message: readiness.message,
      missing: readiness.missing,
      callerIds: readiness.callerIds,
      supportedCountries: ["US", "GB"],
      recordingEnabled: false,
    };
  }

  private async enforceRateLimit(userId: string, kind: "token" | "call") {
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    if (this.storage) {
      const result = kind === "token"
        ? await this.storage.from("crm_voice_sessions").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", cutoff)
        : await this.storage.from("crm_voice_calls").select("id", { count: "exact", head: true }).eq("user_id", userId).gte("created_at", cutoff);
      if (result.error) throw new ServiceUnavailableException("Calling limits could not be checked. Try again shortly.");
      if ((result.count || 0) >= 20) throw new ConflictException("Calling rate limit reached. Try again later.");
      return;
    }
    const map = kind === "token" ? this.tokenTimes : this.callTimes;
    const times = (map.get(userId) || []).filter((time) => time > Date.now() - 60 * 60_000);
    if (times.length >= 20) throw new ConflictException("Calling rate limit reached. Try again later.");
    times.push(Date.now()); map.set(userId, times);
  }

  async issueToken(userId: string) {
    const readiness = this.provider.readiness();
    if (!readiness.configured) throw new ServiceUnavailableException("Browser calling is not configured yet. Ask an administrator to complete Telnyx setup.");
    await this.enforceRateLimit(userId, "token");
    const expiresAt = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
    let issued: Awaited<ReturnType<VoiceProvider["issueBrowserCredential"]>> | null = null;
    try {
      issued = await this.provider.issueBrowserCredential();
      const sessionId = randomUUID();
      const session = {
        id: sessionId, user_id: userId, telnyx_credential_id: issued.credential.id,
        sip_username: issued.credential.username, connection_id: this.provider.sipConnectionId(),
        expires_at: expiresAt, revoked_at: null, created_at: new Date().toISOString(),
      };
      if (this.storage) {
        const { error } = await this.storage.from("crm_voice_sessions").insert(session);
        if (error) throw new Error("Voice session could not be saved.");
      } else this.sessions.set(sessionId, session);
      return { token: issued.token, sessionId, expiresAt };
    } catch {
      if (issued?.credential.id) await this.provider.deleteBrowserCredential(issued.credential.id).catch(() => undefined);
      throw new ServiceUnavailableException("Could not start a secure Telnyx browser session. Check server configuration and try again.");
    }
  }

  async revokeSession(userId: string, sessionId: unknown) {
    if (typeof sessionId !== "string" || sessionId.length > 80) throw new BadRequestException("A valid calling session is required.");
    let session: Record<string, any> | null;
    if (this.storage) {
      const found = await this.storage.from("crm_voice_sessions").select("*").eq("id", sessionId).eq("user_id", userId).maybeSingle();
      if (found.error) throw new ServiceUnavailableException("The calling session could not be checked.");
      session = found.data;
    } else session = this.sessions.get(sessionId) || null;
    if (!session || session.user_id !== userId) throw new NotFoundException("Calling session not found.");
    if (!session.revoked_at) {
      const revokedAt = new Date().toISOString();
      if (this.storage) {
        const { error } = await this.storage.from("crm_voice_sessions").update({ revoked_at: revokedAt }).eq("id", sessionId).eq("user_id", userId);
        if (error) throw new ServiceUnavailableException("The calling session could not be revoked.");
      } else this.sessions.set(sessionId, { ...session, revoked_at: revokedAt });
      await this.provider.deleteBrowserCredential(session.telnyx_credential_id).catch(() => undefined);
    }
    return { revoked: true };
  }

  private async ownedSession(sessionId: string, userId: string) {
    let session: Record<string, any> | null;
    if (this.storage) {
      const result = await this.storage.from("crm_voice_sessions").select("*").eq("id", sessionId).eq("user_id", userId).maybeSingle();
      if (result.error) throw new ServiceUnavailableException("Could not verify the calling session.");
      session = result.data;
    } else session = this.sessions.get(sessionId) || null;
    if (!session || session.user_id !== userId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      throw new UnauthorizedException("Your calling session expired. Reopen the dialer to continue.");
    }
    return session;
  }

  async authorizeCall(userId: string, body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Call details are required.");
    const input = body as Record<string, unknown>;
    const sessionId = typeof input.sessionId === "string" && input.sessionId.length <= 80 ? input.sessionId : "";
    if (!sessionId) throw new BadRequestException("A valid calling session is required.");
    const session = await this.ownedSession(sessionId, userId);
    const target = normalizeVoiceNumber(input.destination);
    const callerId = this.provider.readiness().callerIds[target.country];
    if (!callerId || !this.provider.callerId(target.country)) throw new ServiceUnavailableException(`No authorized ${target.country === "US" ? "US" : "UK"} caller ID is configured.`);
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey)) throw new BadRequestException("A valid idempotency key is required.");
    const contactId = typeof input.contactId === "string" && input.contactId.length <= 120 ? input.contactId.trim() || null : null;
    if (input.contactId !== undefined && input.contactId !== null && typeof input.contactId !== "string") throw new BadRequestException("Contact ID must be text.");
    const companyId = typeof input.companyId === "string" && input.companyId.length <= 120 ? input.companyId.trim() || null : null;
    if (input.companyId !== undefined && input.companyId !== null && typeof input.companyId !== "string") throw new BadRequestException("Company ID must be text.");
    if (contactId && companyId) throw new BadRequestException("Link a call to either a contact or a company, not both.");
    if (contactId || companyId) {
      const { data } = await this.workspace.getWorkspace(userId);
      if (contactId && !data.contacts.some((contact) => contact.id === contactId)) throw new NotFoundException("The selected contact was not found in your workspace.");
      if (companyId && !data.companies.some((company) => company.id === companyId)) throw new NotFoundException("The selected company was not found in your workspace.");
    }
    if (this.storage) {
      const duplicate = await this.storage.from("crm_voice_calls").select("*").eq("user_id", userId).eq("idempotency_key", idempotencyKey).maybeSingle();
      if (duplicate.error) throw new ServiceUnavailableException("Could not check the call request.");
      if (duplicate.data) return this.callAuthorizationResponse(rowToCall(duplicate.data));
      const active = await this.storage.from("crm_voice_calls").select("id").eq("user_id", userId).in("status", activeStatuses).limit(1);
      if (active.error) throw new ServiceUnavailableException("Could not check active calls.");
      if (active.data?.length) throw new ConflictException("End the active call before starting another.");
    } else {
      if ([...this.calls.values()].some((call) => call.userId === userId && activeStatuses.includes(call.status))) throw new ConflictException("End the active call before starting another.");
      const duplicate = [...this.calls.values()].find((call) => call.userId === userId && call.idempotencyKey === idempotencyKey);
      if (duplicate) return this.callAuthorizationResponse(duplicate);
    }
    await this.enforceRateLimit(userId, "call");
    const now = new Date().toISOString();
    const call: VoiceCall = {
      id: randomUUID(), userId, sessionId: session.id, contactId, companyId, idempotencyKey,
      destination: target.e164, callerNumber: callerId, provider: "telnyx", status: "authorized",
      webrtcCallControlId: null, pstnCallControlId: null, startedAt: now, answeredAt: null,
      endedAt: null, durationSeconds: null, failureReason: null, outcome: null, note: null,
      followUpDate: null, followUpTaskId: null, endRequestedAt: null, createdAt: now, updatedAt: now,
    };
    if (this.storage) {
      const { error } = await this.storage.from("crm_voice_calls").insert(callToRow(call));
      if (error) throw new ServiceUnavailableException("The call could not be authorized.");
    } else this.calls.set(call.id, call);
    return this.callAuthorizationResponse(call);
  }

  private callAuthorizationResponse(call: VoiceCall) {
    return { id: call.id, destination: call.destination, callerId: call.callerNumber, status: call.status };
  }

  private async getCall(id: string, userId?: string): Promise<VoiceCall | null> {
    if (this.storage) {
      let query = this.storage.from("crm_voice_calls").select("*").eq("id", id);
      if (userId) query = query.eq("user_id", userId);
      const result = await query.maybeSingle();
      if (result.error) throw new ServiceUnavailableException("Call history could not be loaded.");
      return result.data ? rowToCall(result.data) : null;
    }
    const call = this.calls.get(id);
    return call && (!userId || call.userId === userId) ? { ...call } : null;
  }

  private async persistCall(call: VoiceCall) {
    call.updatedAt = new Date().toISOString();
    if (this.storage) {
      const { error } = await this.storage.from("crm_voice_calls").update(callToRow(call)).eq("id", call.id).eq("user_id", call.userId);
      if (error) throw new ServiceUnavailableException("Call status could not be saved.");
    } else this.calls.set(call.id, { ...call });
  }

  async endCall(userId: string, id: string) {
    const call = await this.getCall(id, userId);
    if (!call) throw new NotFoundException("Call not found.");
    if (!activeStatuses.includes(call.status)) return { call: safeCall(call) };
    call.endRequestedAt = new Date().toISOString();
    call.status = call.webrtcCallControlId || call.pstnCallControlId ? "ending" : "cancelled";
    if (call.status === "cancelled") call.endedAt = call.endRequestedAt;
    await this.persistCall(call);
    for (const controlId of [call.webrtcCallControlId, call.pstnCallControlId].filter((value): value is string => Boolean(value))) {
      await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
    }
    await this.revokeSession(userId, call.sessionId).catch(() => undefined);
    return { call: safeCall(call) };
  }

  async listCalls(userId: string, contactId?: string, companyId?: string) {
    if (contactId !== undefined && (typeof contactId !== "string" || contactId.length > 120)) throw new BadRequestException("Contact ID is invalid.");
    if (companyId !== undefined && (typeof companyId !== "string" || companyId.length > 120)) throw new BadRequestException("Company ID is invalid.");
    if (contactId && companyId) throw new BadRequestException("Filter by either a contact or a company, not both.");
    if (this.storage) {
      let query = this.storage.from("crm_voice_calls").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(100);
      if (contactId) query = query.eq("contact_id", contactId);
      if (companyId) query = query.eq("company_id", companyId);
      const result = await query;
      if (result.error) throw new ServiceUnavailableException("Call history could not be loaded.");
      return { calls: (result.data || []).map((row) => safeCall(rowToCall(row))) };
    }
    return { calls: [...this.calls.values()].filter((call) => call.userId === userId && (!contactId || call.contactId === contactId) && (!companyId || call.companyId === companyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(safeCall) };
  }

  async getCallStatus(userId: string, id: string) {
    const call = await this.getCall(id, userId);
    if (!call) throw new NotFoundException("Call not found.");
    return { call: safeCall(call) };
  }

  async saveOutcome(userId: string, id: string, body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequestException("Call outcome is required.");
    const input = body as Record<string, unknown>;
    if (typeof input.outcome !== "string" || !outcomes.includes(input.outcome as (typeof outcomes)[number])) throw new BadRequestException("Select a valid call outcome.");
    const note = input.note === undefined ? "" : input.note;
    if (typeof note !== "string" || note.length > 1000) throw new BadRequestException("Notes must be 1,000 characters or fewer.");
    const date = input.followUpDate === undefined || input.followUpDate === null || input.followUpDate === "" ? null : input.followUpDate;
    if (date !== null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new BadRequestException("Enter a valid follow-up date.");
    const call = await this.getCall(id, userId);
    if (!call) throw new NotFoundException("Call not found.");
    if (activeStatuses.includes(call.status)) throw new ConflictException("End the call before recording an outcome.");
    call.outcome = input.outcome;
    call.note = note.trim() || null;
    call.followUpDate = date as string | null;
    call.followUpTaskId = (call.contactId || call.companyId) && call.followUpDate ? `voice-follow-up-${call.id}` : null;
    await this.persistCall(call);
    await this.persistCrmOutcome(call);
    return { call: safeCall(call) };
  }

  private async persistCrmOutcome(call: VoiceCall) {
    const recordType = call.contactId ? "contact" : call.companyId ? "company" : null;
    const recordId = call.contactId || call.companyId;
    if (!recordType || !recordId) return;
    const now = new Date().toISOString();
    const activityId = `voice-call-${call.id}`;
    const activity = {
      id: activityId, type: "call", title: `Call outcome: ${call.outcome}`,
      detail: [call.destination, call.durationSeconds === null ? "Duration unavailable" : `${call.durationSeconds}s`, call.note].filter(Boolean).join(" · "),
      recordType, recordId, user: "Voice call", createdAt: call.endedAt || now,
    };
    const taskId = `voice-follow-up-${call.id}`;
    const task = call.followUpDate ? {
      id: taskId, title: `Follow up after call`, description: call.note || `Call follow-up for ${call.destination}`,
      type: "Call follow-up", recordType, recordId, owner: "",
      priority: "Medium", dueDate: call.followUpDate, status: "To Do", completedAt: "", notes: "",
      createdAt: now, updatedAt: now,
    } : null;
    if (this.storage) {
      const activityResult = await this.storage.from("crm_activities").upsert({ user_id: call.userId, id: activityId, position: 0, payload: activity, updated_at: now }, { onConflict: "user_id,id" });
      if (activityResult.error) throw new ServiceUnavailableException(`The call is saved, but its ${recordType} timeline could not be updated.`);
      if (task) {
        const taskResult = await this.storage.from("crm_tasks").upsert({ user_id: call.userId, id: taskId, position: 0, payload: task, updated_at: now }, { onConflict: "user_id,id" });
        if (taskResult.error) throw new ServiceUnavailableException("The call is saved, but its follow-up task could not be created.");
      } else {
        await this.storage.from("crm_tasks").delete().eq("user_id", call.userId).eq("id", taskId);
      }
      return;
    }
    const { data } = await this.workspace.getWorkspace(call.userId);
    data.activities = [activity, ...data.activities.filter((item) => item.id !== activityId)];
    if (task) data.tasks = [task, ...data.tasks.filter((item) => item.id !== taskId)];
    else data.tasks = data.tasks.filter((item) => item.id !== taskId);
    await this.workspace.saveWorkspace(call.userId, { data });
  }

  async processWebhook(rawBody: string, headers: { "telnyx-signature-ed25519"?: string; "telnyx-timestamp"?: string }) {
    if (!rawBody || Buffer.byteLength(rawBody) > 2_000_000) throw new BadRequestException("Webhook body is invalid.");
    let event: TelnyxVoiceEvent;
    try { event = await this.provider.verifyWebhook(rawBody, headers); }
    catch { throw new UnauthorizedException("Telnyx webhook signature validation failed."); }
    const eventData = event.data;
    const eventId = typeof eventData?.id === "string" ? eventData.id : "";
    const eventType = typeof eventData?.event_type === "string" ? eventData.event_type : "";
    if (!eventId || !eventType || !eventData?.payload || typeof eventData.payload !== "object") throw new BadRequestException("Telnyx event is incomplete.");
    if (this.storage) {
      const inserted = await this.storage.from("crm_voice_webhook_events").insert({ id: eventId, event_type: eventType, processing_status: "processing" });
      if (inserted.error?.code === "23505") {
        const existing = await this.storage.from("crm_voice_webhook_events").select("processing_status").eq("id", eventId).maybeSingle();
        if (existing.error) throw new ServiceUnavailableException("Webhook retry status could not be checked.");
        if (!existing.data || existing.data.processing_status !== "failed") return { received: true, duplicate: true };
        const claimed = await this.storage.from("crm_voice_webhook_events").update({ processing_status: "processing", last_error: null }).eq("id", eventId).eq("processing_status", "failed").select("id").maybeSingle();
        if (claimed.error || !claimed.data) return { received: true, duplicate: true };
      }
      if (inserted.error) throw new ServiceUnavailableException("Webhook event could not be recorded.");
    } else {
      if (this.webhookEvents.has(eventId)) return { received: true, duplicate: true };
      this.webhookEvents.add(eventId);
    }
    try {
      await this.handleWebhookEvent(eventType, eventData.payload as Record<string, unknown>, eventData.occurred_at || new Date().toISOString());
      if (this.storage) await this.storage.from("crm_voice_webhook_events").update({ processing_status: "processed", processed_at: new Date().toISOString() }).eq("id", eventId);
      return { received: true };
    } catch (error) {
      if (this.storage) await this.storage.from("crm_voice_webhook_events").update({ processing_status: "failed", last_error: "Event handling failed", processed_at: new Date().toISOString() }).eq("id", eventId);
      throw error;
    }
  }

  private async callForWebhook(payload: Record<string, unknown>, eventType: string) {
    const suppliedId = correlationId(payload);
    if (suppliedId) {
      const byId = await this.getCall(suppliedId);
      if (byId) return byId;
    }
    const controlId = typeof payload.call_control_id === "string" ? payload.call_control_id : "";
    if (controlId && this.storage) {
      const webrtc = await this.storage.from("crm_voice_calls").select("*").eq("webrtc_call_control_id", controlId).maybeSingle();
      if (webrtc.error) throw new ServiceUnavailableException("Call event could not be matched.");
      if (webrtc.data) return rowToCall(webrtc.data);
      const pstn = await this.storage.from("crm_voice_calls").select("*").eq("pstn_call_control_id", controlId).maybeSingle();
      if (pstn.error) throw new ServiceUnavailableException("Call event could not be matched.");
      if (pstn.data) return rowToCall(pstn.data);
    } else if (controlId) {
      const found = [...this.calls.values()].find((call) => call.webrtcCallControlId === controlId || call.pstnCallControlId === controlId);
      if (found) return { ...found };
    }
    return null;
  }

  private async handleWebhookEvent(eventType: string, payload: Record<string, unknown>, occurredAt: string) {
    if (!eventType.startsWith("call.")) return;
    const controlId = typeof payload.call_control_id === "string" ? payload.call_control_id : "";
    if (eventType === "call.initiated") {
      const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : "";
      if (connectionId === this.provider.voiceApplicationId()) {
        const pstnCallId = fromClientState(payload.client_state);
        const pstnCall = pstnCallId ? await this.getCall(pstnCallId) : null;
        const from = typeof payload.from === "string" ? payload.from : "";
        const to = typeof payload.to === "string" ? payload.to : "";
        if (!pstnCall || !controlId || controlId === pstnCall.webrtcCallControlId || from !== pstnCall.callerNumber || to !== pstnCall.destination || ["ended", "failed", "cancelled"].includes(pstnCall.status)) {
          if (controlId) await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
          return;
        }
        if (pstnCall.pstnCallControlId && pstnCall.pstnCallControlId !== controlId) {
          await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
          return;
        }
        pstnCall.pstnCallControlId = controlId;
        if (pstnCall.status === "ending") {
          await this.persistCall(pstnCall);
          await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
          return;
        }
        if (pstnCall.status === "connecting") pstnCall.status = "dialing";
        await this.persistCall(pstnCall);
        return;
      }
      const callId = customHeaderCallId(payload);
      const call = callId ? await this.getCall(callId) : null;
      const expectedConnection = this.provider.sipConnectionId();
      const from = typeof payload.from === "string" ? payload.from : "";
      const to = typeof payload.to === "string" ? payload.to : "";
      const directionValue = typeof payload.direction === "string" ? payload.direction : payload.call_direction;
      const direction = typeof directionValue === "string" ? directionValue.toLowerCase() : "";
      const state = typeof payload.state === "string" ? payload.state.toLowerCase() : "";
      if (!call || !controlId || call.status !== "authorized" || !connectionId || connectionId !== expectedConnection || direction !== "outgoing" || state !== "parked" || from !== call.callerNumber || to !== call.destination) {
        if (controlId) await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
        return;
      }
      call.webrtcCallControlId = controlId;
      if (Number.isFinite(Date.parse(occurredAt))) call.startedAt = new Date(occurredAt).toISOString();
      call.status = "connecting";
      await this.persistCall(call);
      try {
        const dialed = await this.provider.dialPstn({
          destination: call.destination, callerId: call.callerNumber,
          clientState: Buffer.from(JSON.stringify(call.id)).toString("base64"),
          webhookUrl: this.provider.webhookUrl(), commandId: randomUUID(),
        });
        const current = await this.getCall(call.id) || call;
        if (current.pstnCallControlId && current.pstnCallControlId !== dialed.callControlId) {
          await this.provider.hangup(dialed.callControlId, randomUUID()).catch(() => undefined);
          return;
        }
        current.pstnCallControlId = dialed.callControlId;
        if (current.status === "connecting") current.status = "dialing";
        await this.persistCall(current);
      } catch {
        call.status = "failed";
        call.failureReason = "The call could not be started by the voice provider.";
        call.endedAt = occurredAt;
        await this.persistCall(call);
        await this.provider.hangup(controlId, randomUUID()).catch(() => undefined);
        await this.revokeSession(call.userId, call.sessionId).catch(() => undefined);
      }
      return;
    }
    const call = await this.callForWebhook(payload, eventType);
    if (!call) return;
    if (eventType === "call.answered") {
      const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : "";
      const correlated = correlationId(payload) === call.id;
      if (connectionId !== this.provider.voiceApplicationId() || !controlId || controlId === call.webrtcCallControlId) return;
      if (call.pstnCallControlId && controlId !== call.pstnCallControlId) return;
      if (!call.pstnCallControlId && (!correlated || !["connecting", "dialing"].includes(call.status))) return;
      call.pstnCallControlId = call.pstnCallControlId || controlId;
      if (call.status === "ended" || call.status === "failed" || call.status === "cancelled") return;
      if (call.status === "ending") {
        await this.provider.hangup(call.webrtcCallControlId || controlId, randomUUID()).catch(() => undefined);
        await this.provider.hangup(call.pstnCallControlId, randomUUID()).catch(() => undefined);
        return;
      }
      call.answeredAt = call.answeredAt || occurredAt;
      call.status = "connected";
      await this.persistCall(call);
      if (call.webrtcCallControlId) {
        try { await this.provider.bridge(call.webrtcCallControlId, call.pstnCallControlId, randomUUID()); }
        catch {
          call.status = "failed"; call.failureReason = "The call could not be connected to the browser."; call.endedAt = occurredAt;
          await this.persistCall(call);
          await this.provider.hangup(call.webrtcCallControlId, randomUUID()).catch(() => undefined);
          await this.provider.hangup(call.pstnCallControlId, randomUUID()).catch(() => undefined);
          await this.revokeSession(call.userId, call.sessionId).catch(() => undefined);
        }
      }
      return;
    }
    if (eventType === "call.hangup") {
      const connectionId = typeof payload.connection_id === "string" ? payload.connection_id : "";
      if (controlId === call.webrtcCallControlId) {
        if (connectionId !== this.provider.sipConnectionId()) return;
      } else if (controlId === call.pstnCallControlId) {
        if (connectionId !== this.provider.voiceApplicationId()) return;
      } else if (controlId && correlationId(payload) === call.id && connectionId === this.provider.voiceApplicationId() && !call.pstnCallControlId && controlId !== call.webrtcCallControlId) {
        call.pstnCallControlId = controlId;
      } else return;
      if (["ended", "failed", "cancelled"].includes(call.status)) return;
      const wasAnswered = Boolean(call.answeredAt);
      call.endedAt = Number.isFinite(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : new Date().toISOString();
      call.status = wasAnswered ? "ended" : call.endRequestedAt ? "cancelled" : "failed";
      call.durationSeconds = wasAnswered ? Math.max(0, Math.floor((Date.parse(call.endedAt) - Date.parse(call.answeredAt!)) / 1000)) : 0;
      const cause = payload.hangup_cause;
      call.failureReason = wasAnswered || call.endRequestedAt || typeof cause !== "string" ? null : cause.slice(0, 120);
      await this.persistCall(call);
      const peer = controlId === call.webrtcCallControlId ? call.pstnCallControlId : call.webrtcCallControlId;
      if (peer) await this.provider.hangup(peer, randomUUID()).catch(() => undefined);
      await this.revokeSession(call.userId, call.sessionId).catch(() => undefined);
    }
  }
}
