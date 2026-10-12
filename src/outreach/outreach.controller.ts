import { Body, Controller, Delete, Get, Headers, Inject, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { OutreachService } from "./outreach.service";

type OutreachRequest = { user: { id: string; email?: string } };

@Controller("outreach")
export class OutreachController {
  constructor(@Inject(OutreachService) private readonly outreachService: OutreachService) {}

  @Post("gmail/connect")
  @UseGuards(SupabaseAuthGuard)
  beginGmailConnection(@Req() request: OutreachRequest) {
    return this.outreachService.beginGmailConnection(request.user.id);
  }

  @Get("gmail/status")
  @UseGuards(SupabaseAuthGuard)
  getGmailStatus(@Req() request: OutreachRequest) {
    return this.outreachService.getGmailStatus(request.user.id);
  }

  @Post("gmail/disconnect")
  @UseGuards(SupabaseAuthGuard)
  disconnectGmail(@Req() request: OutreachRequest) {
    return this.outreachService.disconnectGmail(request.user.id);
  }

  @Get("providers")
  @UseGuards(SupabaseAuthGuard)
  getProviderSettings(@Req() request: OutreachRequest) {
    return this.outreachService.getProviderSettings(request.user.id);
  }

  @Patch("providers/sending")
  @UseGuards(SupabaseAuthGuard)
  setSendingPaused(@Req() request: OutreachRequest, @Body() body: unknown) {
    return this.outreachService.setSendingPaused(request.user.id, (body as { paused?: unknown })?.paused);
  }

  @Patch("providers/:provider")
  @UseGuards(SupabaseAuthGuard)
  updateProviderSettings(@Req() request: OutreachRequest, @Param("provider") provider: string, @Body() body: unknown) {
    return this.outreachService.updateProviderSettings(request.user.id, provider, body);
  }

  @Post("providers/:provider/test")
  @UseGuards(SupabaseAuthGuard)
  testProvider(@Req() request: OutreachRequest, @Param("provider") provider: string) {
    return this.outreachService.testProvider(request.user.id, provider);
  }

  @Post("providers/default")
  @UseGuards(SupabaseAuthGuard)
  setDefaultProvider(@Req() request: OutreachRequest, @Body() body: unknown) {
    return this.outreachService.setDefaultProvider(request.user.id, (body as { provider?: unknown })?.provider);
  }

  @Get("suppressions")
  @UseGuards(SupabaseAuthGuard)
  getSuppressions(@Req() request: OutreachRequest) {
    return this.outreachService.getSuppressions(request.user.id);
  }

  @Delete("suppressions/:email")
  @UseGuards(SupabaseAuthGuard)
  removeSuppression(@Req() request: OutreachRequest, @Param("email") email: string) {
    return this.outreachService.removeSuppression(request.user.id, email);
  }

  @Get("messages")
  @UseGuards(SupabaseAuthGuard)
  getMessages(@Req() request: OutreachRequest) {
    return this.outreachService.getMessages(request.user.id);
  }

  @Get("stats")
  @UseGuards(SupabaseAuthGuard)
  getStats(@Req() request: OutreachRequest) {
    return this.outreachService.getStats(request.user.id);
  }

  @Post("messages")
  @UseGuards(SupabaseAuthGuard)
  sendMessage(@Req() request: OutreachRequest, @Body() body: unknown) {
    return this.outreachService.sendMessage(request.user.id, body);
  }

  @Post("sync")
  @UseGuards(SupabaseAuthGuard)
  syncReplies(@Req() request: OutreachRequest) {
    return this.outreachService.syncReplies(request.user.id);
  }
}

@Controller("outreach")
export class OutreachPublicController {
  constructor(@Inject(OutreachService) private readonly outreachService: OutreachService) {}

  @Get("gmail/callback")
  async gmailCallback(@Query("code") code: string, @Query("state") state: string, @Query("error") oauthError: string, @Res() response: any) {
    try {
      if (oauthError) throw new Error("Google authorization was declined.");
      await this.outreachService.completeGmailConnection(code, state);
      return response.redirect(302, this.outreachService.frontendResultUrl("connected"));
    } catch {
      return response.redirect(302, this.outreachService.frontendResultUrl("error"));
    }
  }

  @Get("click/:token")
  async trackClick(@Param("token") token: string, @Res() response: any) {
    const targetUrl = await this.outreachService.recordClick(token);
    return response.redirect(302, targetUrl);
  }

  @Post("webhooks/resend/:userId")
  async resendWebhook(
    @Param("userId") userId: string,
    @Req() request: { rawBody?: Buffer },
    @Headers("svix-id") id: string,
    @Headers("svix-timestamp") timestamp: string,
    @Headers("svix-signature") signature: string,
  ) {
    return this.outreachService.processResendWebhook(userId, request.rawBody?.toString("utf8") || "", { id, timestamp, signature });
  }

  @Post("webhooks/ses/:userId")
  async sesWebhook(@Param("userId") userId: string, @Req() request: { rawBody?: Buffer }) {
    return this.outreachService.processSesWebhook(userId, request.rawBody?.toString("utf8") || "");
  }
}
