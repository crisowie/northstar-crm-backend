import { Module } from "@nestjs/common";
import { WorkspaceModule } from "../workspace/workspace.module";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { VoiceController, VoiceWebhookController } from "./voice.controller";
import { TelnyxVoiceProvider, VOICE_PROVIDER } from "./voice-provider";
import { VoiceService } from "./voice.service";

@Module({
  imports: [WorkspaceModule],
  controllers: [VoiceController, VoiceWebhookController],
  providers: [SupabaseAuthGuard, TelnyxVoiceProvider, { provide: VOICE_PROVIDER, useExisting: TelnyxVoiceProvider }, VoiceService],
  exports: [TelnyxVoiceProvider],
})
export class VoiceModule {}
