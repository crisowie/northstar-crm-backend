import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { HealthController } from "./health.controller";
import { OutreachModule } from "./outreach/outreach.module";
import { WorkspaceModule } from "./workspace/workspace.module";

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), WorkspaceModule, OutreachModule],
  controllers: [HealthController],
})
export class AppModule {}
