import { Module } from "@nestjs/common";
import { WorkspaceModule } from "../workspace/workspace.module";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { SmsController } from "./sms.controller";
import { SMS_PROVIDER, TelnyxSmsProvider } from "./sms-provider";
import { SmsService } from "./sms.service";

@Module({
  imports: [WorkspaceModule],
  controllers: [SmsController],
  providers: [SupabaseAuthGuard, TelnyxSmsProvider, { provide: SMS_PROVIDER, useExisting: TelnyxSmsProvider }, SmsService],
})
export class SmsModule {}
