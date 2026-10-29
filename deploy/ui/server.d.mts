// Types for deploy/ui/server.mjs, which runs as plain JavaScript in the production image.
import type { Server } from "node:http";

export type SiteFile = { body: Buffer; type: string };
export type Site = Map<string, SiteFile>;
export type SecurityHeaders = { app: string; worker: string; common: Record<string, string> };
export type Response = { status: number; headers: Record<string, string>; body: Buffer };

export function loadSite(root: string): Site;
export function loadHeaders(file: string): SecurityHeaders;
export function checkBasePath(basePath: string): string;
export function createHandler(options: { site: Site; headers: SecurityHeaders; basePath?: string }): (method: string | undefined, rawUrl: string | undefined) => Response;
export function startServer(options: { site: Site; headers: SecurityHeaders; basePath?: string; port?: number; host?: string }): Promise<Server>;
