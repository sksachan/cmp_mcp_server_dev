export function sanitizeName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized || "hello-world";
}

export function deriveStackName(appName: string, environment: string): string {
  return `${sanitizeName(appName)}-${sanitizeName(environment)}-eks`;
}
