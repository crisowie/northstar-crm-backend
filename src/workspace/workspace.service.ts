import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const emptyWorkspace = {
  organization: "My workspace",
  pipelineStages: ["Lead Identified", "Qualified", "Discovery", "Proposal", "Negotiation", "Won", "Lost"],
  jobStatuses: ["New", "Planned", "In Progress", "On Hold", "Completed", "Cancelled"],
  contacts: [],
  companies: [],
  jobs: [],
  opportunities: [],
  tasks: [],
  notes: [],
  activities: [],
};

type CrmWorkspace = {
  organization: string;
  pipelineStages: string[];
  jobStatuses: string[];
  contacts: Record<string, unknown>[];
  companies: Record<string, unknown>[];
  jobs: Record<string, unknown>[];
  opportunities: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  activities: Record<string, unknown>[];
};

const entityTables = [
  ["contacts", "crm_contacts"],
  ["companies", "crm_companies"],
  ["jobs", "crm_jobs"],
  ["opportunities", "crm_opportunities"],
  ["tasks", "crm_tasks"],
  ["notes", "crm_notes"],
  ["activities", "crm_activities"],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWorkspace(value: unknown): value is CrmWorkspace {
  if (!isRecord(value) || typeof value.organization !== "string") return false;
  if (!Array.isArray(value.pipelineStages) || !value.pipelineStages.every((stage) => typeof stage === "string")) return false;
  if (!Array.isArray(value.jobStatuses) || !value.jobStatuses.every((status) => typeof status === "string")) return false;
  return entityTables.every(([key]) => {
    const records = value[key];
    return Array.isArray(records)
      && records.length <= 10_000
      && records.every((record) => isRecord(record) && typeof record.id === "string" && record.id.trim().length > 0);
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

@Injectable()
export class WorkspaceService {
  private readonly storageClient: SupabaseClient | null;
  private readonly volatileWorkspaces = new Map<string, CrmWorkspace>();

  constructor(@Inject(ConfigService) config: ConfigService) {
    const url = config.get<string>("SUPABASE_URL")?.trim();
    const serviceRoleKey = config.get<string>("SUPABASE_SERVICE_ROLE_KEY")?.trim();
    const isProduction = (config.get<string>("NODE_ENV") || process.env.NODE_ENV) === "production";

    if (Boolean(url) !== Boolean(serviceRoleKey)) {
      throw new Error("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or leave both empty for local development.");
    }
    if (!url || !serviceRoleKey) {
      if (isProduction) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production.");
      this.storageClient = null;
      return;
    }

    this.storageClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async getWorkspace(userId: string) {
    if (!this.storageClient) {
      return { data: clone(this.volatileWorkspaces.get(userId) || emptyWorkspace) };
    }

    const [settingsResult, ...entityResults] = await Promise.all([
      this.storageClient
        .from("crm_settings")
        .select("organization,pipeline_stages,job_statuses")
        .eq("user_id", userId)
        .maybeSingle(),
      ...entityTables.map(([, table]) => this.storageClient!
        .from(table)
        .select("payload")
        .eq("user_id", userId)
        .order("position", { ascending: true })),
    ]);

    if (settingsResult.error || entityResults.some((result) => result.error)) {
      throw new ServiceUnavailableException("Could not load CRM data from Supabase. Confirm that migration 002 has been applied.");
    }

    const settings = settingsResult.data;
    const data: CrmWorkspace = {
      ...clone(emptyWorkspace),
      ...(settings ? {
        organization: settings.organization,
        pipelineStages: settings.pipeline_stages,
        jobStatuses: settings.job_statuses,
      } : {}),
    };

    entityTables.forEach(([key], index) => {
      data[key] = (entityResults[index].data || []).map((row) => row.payload as Record<string, unknown>);
    });
    return { data };
  }

  async saveWorkspace(userId: string, body: unknown) {
    const payload = body as { data?: unknown } | null;
    if (!payload || !isWorkspace(payload.data)) {
      throw new BadRequestException("Workspace data is missing or has an invalid structure.");
    }

    if (!this.storageClient) {
      this.volatileWorkspaces.set(userId, clone(payload.data));
      return { saved: true, storage: "memory" };
    }

    const { error } = await this.storageClient.rpc("save_crm_workspace", {
      p_user_id: userId,
      p_data: payload.data,
    });
    if (error) {
      throw new ServiceUnavailableException("Could not save CRM data to Supabase. Confirm that migration 002 has been applied.");
    }
    return { saved: true, storage: "supabase" };
  }

  async getAnalytics(userId: string, requestedDate?: string) {
    const { data } = await this.getWorkspace(userId);
    const today = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "") ? requestedDate! : new Date().toISOString().slice(0, 10);
    const openOpportunities = data.opportunities.filter((item) => !item.archived && !["Won", "Lost"].includes(String(item.stage)));
    const activeContacts = data.contacts.filter((item) => !item.archived);
    const activeCompanies = data.companies.filter((item) => !item.archived);
    const activeJobs = data.jobs.filter((item) => !item.archived && !["Completed", "Cancelled"].includes(String(item.status)));
    const activeTasks = data.tasks.filter((item) => !["Completed", "Cancelled"].includes(String(item.status)));
    const pipeline = data.pipelineStages.map((stage) => {
      const items = openOpportunities.filter((item) => item.stage === stage);
      return {
        stage,
        count: items.length,
        value: items.reduce((sum, item) => sum + (Number(item.estimatedValue) || 0), 0),
      };
    });
    const dueFollowUps = openOpportunities.filter((item) => asDate(item.nextFollowUp) && asDate(item.nextFollowUp) <= today).length;
    const overdueContactAndOpportunityFollowUps = [
      ...activeContacts.map((item) => asDate(item.nextFollowUp)),
      ...openOpportunities.map((item) => asDate(item.nextFollowUp)),
    ].filter((date) => date && date < today).length;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const wonLast30Days = data.opportunities.filter((item) => {
      if (item.archived || item.stage !== "Won") return false;
      const history = Array.isArray(item.stageHistory) ? item.stageHistory : [];
      const latest = history.at(-1) as Record<string, unknown> | undefined;
      const date = asDate(latest?.date || item.updatedAt);
      const timestamp = date ? new Date(`${date}T12:00:00Z`).getTime() : Number.NaN;
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    }).length;

    return {
      date: today,
      totalContacts: activeContacts.length,
      totalCompanies: activeCompanies.length,
      activeJobs: activeJobs.length,
      openOpportunities: openOpportunities.length,
      needsAttention: dueFollowUps,
      tasksDueToday: activeTasks.filter((task) => asDate(task.dueDate) === today).length,
      overdueFollowUps: overdueContactAndOpportunityFollowUps,
      wonLast30Days,
      totalWon: data.opportunities.filter((item) => !item.archived && item.stage === "Won").length,
      totalLost: data.opportunities.filter((item) => !item.archived && item.stage === "Lost").length,
      openOpportunityValue: openOpportunities.reduce((sum, item) => sum + (Number(item.estimatedValue) || 0), 0),
      pipeline,
    };
  }
}
