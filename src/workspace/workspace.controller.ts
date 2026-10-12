import { Body, Controller, Get, Inject, Put, Query, Req, UseGuards } from "@nestjs/common";
import { SupabaseAuthGuard } from "./supabase-auth.guard";
import { WorkspaceService } from "./workspace.service";

type WorkspaceRequest = { user: { id: string } };

@Controller("crm")
@UseGuards(SupabaseAuthGuard)
export class WorkspaceController {
  constructor(@Inject(WorkspaceService) private readonly workspaceService: WorkspaceService) {}

  @Get("workspace")
  getWorkspace(@Req() request: WorkspaceRequest) {
    return this.workspaceService.getWorkspace(request.user.id);
  }

  @Put("workspace")
  saveWorkspace(@Req() request: WorkspaceRequest, @Body() body: unknown) {
    return this.workspaceService.saveWorkspace(request.user.id, body);
  }

  @Get("analytics")
  getAnalytics(@Req() request: WorkspaceRequest, @Query("date") date?: string) {
    return this.workspaceService.getAnalytics(request.user.id, date);
  }
}
