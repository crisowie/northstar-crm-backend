import { Module } from "@nestjs/common";
import { SupabaseAuthGuard } from "./supabase-auth.guard";
import { WorkspaceController } from "./workspace.controller";
import { WorkspaceService } from "./workspace.service";

@Module({
  controllers: [WorkspaceController],
  providers: [SupabaseAuthGuard, WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
