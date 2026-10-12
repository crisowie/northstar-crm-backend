import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const LOCAL_DEMO_TOKEN = "northstar-local-demo-token";
export const LOCAL_DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";

type AuthenticatedRequest = {
  headers: { authorization?: string };
  user?: { id: string; email?: string };
};

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly authClient: SupabaseClient | null;
  private readonly localDemoEnabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const nodeEnvironment = config.get<string>("NODE_ENV") || process.env.NODE_ENV || "development";
    const isDevelopment = nodeEnvironment !== "production";
    const authMode = (config.get<string>("AUTH_MODE") || (isDevelopment ? "mock" : "supabase")).trim().toLowerCase();

    if (authMode !== "mock" && authMode !== "supabase") {
      throw new Error("AUTH_MODE must be either 'mock' or 'supabase'.");
    }
    if (authMode === "mock" && !isDevelopment) {
      throw new Error("AUTH_MODE=mock is only available outside production.");
    }

    this.localDemoEnabled = authMode === "mock";
    this.authClient = this.localDemoEnabled ? null : createClient(
      config.getOrThrow<string>("SUPABASE_URL"),
      config.getOrThrow<string>("SUPABASE_ANON_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization || "";
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("A Supabase access token is required.");
    }

    if (this.localDemoEnabled) {
      if (token !== LOCAL_DEMO_TOKEN) throw new UnauthorizedException("The local demo session is invalid.");
      request.user = { id: LOCAL_DEMO_USER_ID, email: "demo@northstar.local" };
      return true;
    }

    const { data, error } = await this.authClient!.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException("Your session is invalid or has expired. Sign in again.");
    }

    request.user = { id: data.user.id, email: data.user.email };
    return true;
  }
}
