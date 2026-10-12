import { Module } from "@nestjs/common";
import { SupabaseAuthGuard } from "../workspace/supabase-auth.guard";
import { WorkspaceModule } from "../workspace/workspace.module";
import { OutreachController, OutreachPublicController } from "./outreach.controller";
import { OutreachService } from "./outreach.service";

@Module({
  imports: [WorkspaceModule],
  controllers: [OutreachController, OutreachPublicController],
  providers: [SupabaseAuthGuard, OutreachService],
})
export class OutreachModule {}
