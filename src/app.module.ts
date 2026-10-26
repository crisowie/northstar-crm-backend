import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health.controller";
import { OutreachModule } from "./outreach/outreach.module";
import { WorkspaceModule } from "./workspace/workspace.module";
import { VoiceModule } from "./voice/voice.module";
import { SmsModule } from "./sms/sms.module";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WorkspaceModule, OutreachModule, VoiceModule, SmsModule],
  controllers: [HealthController],
})
export class AppModule {}
