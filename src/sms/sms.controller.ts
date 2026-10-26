import { Body, Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { SmsService } from "./sms.service";

type AuthenticatedRequest = { user: { id: string } };

@Controller("sms")
@UseGuards(SupabaseAuthGuard)
export class SmsController {
  constructor(@Inject(SmsService) private readonly sms: SmsService) {}

  @Get("config")
  getConfig() {
    return this.sms.getConfig();
  }

  @Get("messages")
  listMessages(@Req() request: AuthenticatedRequest) {
    return this.sms.listMessages(request.user.id);
  }

  @Post("messages")
  sendMessage(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.sms.sendMessage(request.user.id, body);
  }
}
