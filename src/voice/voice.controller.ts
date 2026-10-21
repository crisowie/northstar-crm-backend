import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { VoiceService } from "./voice.service";

type AuthenticatedRequest = { user: { id: string }; rawBody?: Buffer };

@Controller("voice")
@UseGuards(SupabaseAuthGuard)
export class VoiceController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}

  @Get("config")
  getConfig() { return this.voice.getConfig(); }

  @Post("token")
  issueToken(@Req() request: AuthenticatedRequest) { return this.voice.issueToken(request.user.id); }

  @Post("session/end")
  revokeSession(@Req() request: AuthenticatedRequest, @Body() body: { sessionId?: unknown }) { return this.voice.revokeSession(request.user.id, body?.sessionId); }

  @Post("calls")
  authorizeCall(@Req() request: AuthenticatedRequest, @Body() body: unknown) { return this.voice.authorizeCall(request.user.id, body); }

  @Get("calls")
  listCalls(@Req() request: AuthenticatedRequest, @Query("contactId") contactId?: string, @Query("companyId") companyId?: string) { return this.voice.listCalls(request.user.id, contactId, companyId); }

  @Get("calls/:id")
  getCall(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.voice.getCallStatus(request.user.id, id); }

  @Post("calls/:id/end")
  endCall(@Req() request: AuthenticatedRequest, @Param("id") id: string) { return this.voice.endCall(request.user.id, id); }

  @Post("calls/:id/outcome")
  saveOutcome(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) { return this.voice.saveOutcome(request.user.id, id, body); }
}

@Controller("voice/webhooks")
export class VoiceWebhookController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}

  @Post()
  receive(
    @Req() request: AuthenticatedRequest,
    @Headers("telnyx-signature-ed25519") signature?: string,
    @Headers("telnyx-timestamp") timestamp?: string,
  ) {
    return this.voice.processWebhook(request.rawBody?.toString("utf8") || "", {
      "telnyx-signature-ed25519": signature,
      "telnyx-timestamp": timestamp,
    });
  }
}
