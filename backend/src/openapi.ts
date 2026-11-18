/** Small, dependency-free OpenAPI index for the API surface. Keep paths aligned
 * with the Nest controllers in main.ts; request/response contracts are refined
 * at the point where a public integration depends on them. */
const endpointGroups: Record<string, Record<string, string[]>> = {
  '/api/v1/health': { get: ['health'] },
  '/api/v1/health/ready': { get: ['health'] },
  '/api/v1/openapi.json': { get: ['documentation'] },
  '/api/v1/auth/setup-status': { get: ['auth'] },
  '/api/v1/auth/setup': { post: ['auth'] },
  '/api/v1/auth/login': { post: ['auth'] },
  '/api/v1/auth/logout': { post: ['auth'] },
  '/api/v1/auth/password': { post: ['auth'] },
  '/api/v1/auth/me': { get: ['auth'] },
  '/api/v1/users': { get: ['users'], post: ['users'] },
  '/api/v1/users/{id}': { patch: ['users'] },
  '/api/v1/machines/options': { get: ['machines'] },
  '/api/v1/machines': { get: ['machines'], post: ['machines'] },
  '/api/v1/machines/{id}': { patch: ['machines'] },
  '/api/v1/people': { get: ['directory'], post: ['directory'] },
  '/api/v1/people/{id}': { patch: ['directory'] },
  '/api/v1/models': { post: ['directory'] },
  '/api/v1/models/{id}': { patch: ['directory'] },
  '/api/v1/repairs': { get: ['repairs'], post: ['repairs'] },
  '/api/v1/repairs/stages': { get: ['repairs'] },
  '/api/v1/repairs/machines': { get: ['repairs'] },
  '/api/v1/repairs/diagnosers': { get: ['repairs'] },
  '/api/v1/repairs/machines/{machineId}/history': { get: ['repairs'] },
  '/api/v1/repairs/{id}': { patch: ['repairs'] },
  '/api/v1/repairs/{id}/events': { get: ['repairs'], post: ['repairs'] },
  '/api/v1/repairs/{id}/events/undo': { post: ['repairs'] },
  '/api/v1/status': { get: ['status'] },
  '/api/v1/status/{id}/events': { get: ['status'] },
  '/api/v1/maintenance': { get: ['maintenance'] },
  '/api/v1/maintenance/{machineId}/history': { get: ['maintenance'] },
  '/api/v1/maintenance/{machineId}/readings': { post: ['maintenance'] },
  '/api/v1/maintenance/{machineId}/services': { post: ['maintenance'] },
  '/api/v1/maintenance/{machineId}/services/bulk': { post: ['maintenance'] },
  '/api/v1/maintenance/{machineId}/services/{id}': { delete: ['maintenance'] },
  '/api/v1/parts': { get: ['parts'], post: ['parts'], delete: ['parts'] },
  '/api/v1/parts/{id}': { patch: ['parts'], delete: ['parts'] },
  '/api/v1/parts/{id}/alternatives': { post: ['parts'] },
  '/api/v1/parts/{id}/alternatives/{alternativeId}': { patch: ['parts'], delete: ['parts'] },
  '/api/v1/dashboard': { get: ['dashboard'] },
  '/api/v1/reports/repairs': { get: ['reports'] },
  '/api/v1/sms/rules': { get: ['sms'], put: ['sms'] },
  '/api/v1/sms/recipients': { get: ['sms'] },
  '/api/v1/sms/provider': { put: ['sms'] },
  '/api/v1/sms/ippanel/patterns': { get: ['sms'] },
  '/api/v1/sms/{id}/delivery': { get: ['sms'] },
  '/api/v1/sms': { get: ['sms'] },
  '/api/v1/sms/{id}/retry': { post: ['sms'] },
  '/api/v1/sms/test': { post: ['sms'] },
  '/api/v1/sms/test-stage': { post: ['sms'] },
    '/api/v1/sms/otp/test': { post: ['sms'] },
  '/api/v1/legacy-workspace': { get: ['migration'], put: ['migration'] },
  '/api/v1/legacy-workspace/migration-preview': { get: ['migration'] },
  '/api/v1/legacy-workspace/import-operations': { post: ['migration'] },
  '/api/v1/analyses': { get: ['analyses'], post: ['analyses'] },
  '/api/v1/analyses/options': { get: ['analyses'] },
  '/api/v1/analyses/{id}': { patch: ['analyses'] },
  '/api/v1/settings/brand': { get: ['settings'] },
  '/api/v1/settings': { get: ['settings'], put: ['settings'] },
  '/api/v1/backups': { get: ['backups'] },
  '/api/v1/backups/{filename}': { get: ['backups'] },
};

const operations: Record<string, unknown> = {};
for (const [path, methods] of Object.entries(endpointGroups)) {
  const pathOperations: Record<string, unknown> = {};
  for (const [method, tags] of Object.entries(methods)) {
    const isMutation = ['post', 'put', 'patch', 'delete'].includes(method);
    pathOperations[method] = {
      tags,
      operationId: `${method}_${path.replace(/^\/api\/v1\//, '').replace(/[{}]/g, '').replaceAll('/', '_')}`,
      summary: `${method.toUpperCase()} ${path}`,
      ...(path.includes('{') || isMutation
        ? { parameters: [
          ...[...path.matchAll(/\{([^}]+)\}/g)].map(match => ({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })),
          ...(isMutation ? [{ name: 'x-sepid-request', in: 'header', required: true, schema: { type: 'string', enum: ['1'] } }] : []),
        ] }
        : {}),
      ...(['/api/v1/health', '/api/v1/health/ready', '/api/v1/openapi.json', '/api/v1/auth/setup-status', '/api/v1/auth/setup', '/api/v1/auth/login'].includes(path)
        ? { security: [] }
        : {}),
      responses: {
        '200': { description: 'درخواست با موفقیت انجام شد' },
        '400': { description: 'ورودی نامعتبر' },
        '401': { description: 'نشست معتبر نیست' },
        '403': { description: 'مجوز کافی وجود ندارد' },
        '409': { description: 'تعارض نسخه یا وضعیت داده' },
      },
    };
  }
  operations[path] = pathOperations;
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Sepid Fleet System API',
    version: '1.0.0',
    description: 'فهرست مسیرهای نسخهٔ فعلی API. درخواست‌های تغییردهنده به سربرگ x-sepid-request: 1 نیاز دارند. ورود با نشست کوکی HttpOnly انجام می‌شود.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: {
      sepidSession: { type: 'apiKey', in: 'cookie', name: 'sepid_session', description: 'نشست مرورگر؛ مقدار کوکی در JavaScript قابل‌خواندن نیست.' },
    },
  },
  security: [{ sepidSession: [] }],
  paths: operations,
} as const;
