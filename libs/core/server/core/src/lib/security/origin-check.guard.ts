import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_KEY_HEADER = 'x-api-key';

interface OriginCheckRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * CSRF protection for the API routes.
 *
 * Session cookies are `SameSite=Lax`, which already stops cross-site POSTs from
 * a form. This is the second line: a state-changing request must either come
 * from an allowed origin, or authenticate with an API key — something a browser
 * cannot attach on behalf of a logged-in user.
 *
 * A token-based scheme (double-submit) would add a round trip and a token to
 * manage without covering anything this does not; the decision is recorded in
 * the security contract.
 */
@Injectable()
export class OriginCheckGuard implements CanActivate {
  // Written out rather than declared as a constructor parameter property:
  // Node's type stripping, which the test runner uses, does not support them.
  private readonly allowedOrigins: readonly string[];

  constructor(allowedOrigins: readonly string[]) {
    this.allowedOrigins = allowedOrigins;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OriginCheckRequest>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    const origin = this.headerValue(request, 'origin');

    if (origin) {
      if (this.allowedOrigins.includes(origin)) {
        return true;
      }

      throw new ForbiddenException(`Origin ${origin} is not allowed`);
    }

    // No Origin header: a non-browser caller. It must prove itself with a key.
    if (this.headerValue(request, API_KEY_HEADER)) {
      return true;
    }

    throw new ForbiddenException(
      'A state-changing request must carry an allowed Origin or an API key',
    );
  }

  private headerValue(
    request: OriginCheckRequest,
    name: string,
  ): string | undefined {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  }
}
