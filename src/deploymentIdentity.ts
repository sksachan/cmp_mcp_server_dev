import type { ArtifactBundle, ValidatedArtifactBundle } from "./artifacts.js";
import type { DeployRequest } from "./schemas.js";

export type DeploymentIdentity = {
  app_name: string;
  stack_name: string;
  cluster_name: string;
  namespace: string;
  aws_region: string;
  environment: string;
};

export type IdentitySource = "request" | "params_json" | "infra_details" | "artifact_root" | "derived" | "k8s_yaml" | "template_yaml";

export type IdentityFinding = {
  source: IdentitySource;
  identity: Partial<DeploymentIdentity>;
};

export type IdentityMismatch = {
  field: keyof DeploymentIdentity;
  expected?: string;
  actual?: string;
  expected_source: string;
  actual_source: string;
};

export type IdentityValidationResult = {
  ok: boolean;
  canonical_identity?: DeploymentIdentity;
  findings: IdentityFinding[];
  mismatches: IdentityMismatch[];
  warnings: string[];
};

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

export function identityFromRequest(request: DeployRequest): DeploymentIdentity {
  return {
    app_name: request.app_name,
    stack_name: request.stack_name,
    cluster_name: request.cluster_name,
    namespace: request.namespace,
    aws_region: request.aws_region,
    environment: request.environment
  };
}

export function validateDeploymentIdentity(input: {
  artifactBundle: ArtifactBundle;
  validatedBundle: ValidatedArtifactBundle;
  requestIdentity?: DeploymentIdentity;
  identityConfirmation?: Partial<DeploymentIdentity>;
}): IdentityValidationResult {
  const findings = collectIdentityFindings(input.artifactBundle, input.validatedBundle, input.requestIdentity, input.identityConfirmation);
  const warnings: string[] = [];
  const expectedFinding = input.requestIdentity
    ? findings.find((finding) => finding.source === "request")
    : input.identityConfirmation
      ? { source: "request" as IdentitySource, identity: input.identityConfirmation }
      : undefined;
  const canonical = completeIdentity(expectedFinding?.identity)
    ?? completeIdentity(findings.find((finding) => finding.source === "params_json")?.identity)
    ?? completeIdentity(findings.find((finding) => finding.source === "infra_details")?.identity)
    ?? completeIdentity(findings.find((finding) => finding.source === "artifact_root")?.identity)
    ?? completeIdentity(findings.find((finding) => finding.source === "derived")?.identity);

  if (!input.requestIdentity && !input.identityConfirmation) {
    warnings.push("Stored MCP request identity is unavailable; execution requires identity_confirmation.");
  }

  const mismatches: IdentityMismatch[] = [];
  const expected = expectedFinding?.identity ?? canonical;
  if (expected) {
    for (const finding of findings) {
      if (finding.source === "derived") continue;
      for (const field of ["app_name", "stack_name", "cluster_name", "namespace", "aws_region", "environment"] as Array<keyof DeploymentIdentity>) {
        const expectedValue = expected[field];
        const actualValue = finding.identity[field];
        if (!expectedValue || !actualValue || expectedValue === actualValue) continue;
        if (field === "environment") {
          warnings.push(`Environment differs between ${expectedFinding?.source ?? "canonical"} (${expectedValue}) and ${finding.source} (${actualValue}).`);
          continue;
        }
        mismatches.push({
          field,
          expected: expectedValue,
          actual: actualValue,
          expected_source: expectedFinding?.source ?? "canonical",
          actual_source: finding.source
        });
      }
    }
  }

  if (!canonical) warnings.push("Could not determine a complete deployment identity from request or artifacts.");
  return {
    ok: Boolean(canonical) && mismatches.length === 0 && Boolean(input.requestIdentity || input.identityConfirmation),
    canonical_identity: canonical,
    findings,
    mismatches,
    warnings
  };
}

export function collectIdentityFindings(
  artifactBundle: ArtifactBundle,
  validatedBundle: ValidatedArtifactBundle,
  requestIdentity?: DeploymentIdentity,
  identityConfirmation?: Partial<DeploymentIdentity>
): IdentityFinding[] {
  const findings: IdentityFinding[] = [];
  if (requestIdentity) findings.push({ source: "request", identity: requestIdentity });
  if (!requestIdentity && identityConfirmation) findings.push({ source: "request", identity: identityConfirmation });

  addFinding(findings, "params_json", withDerivedStackName(identityFromRecord(validatedBundle.metadata)));
  addFinding(findings, "infra_details", withDerivedStackName(identityFromRecord(recordValue(artifactBundle.infra_details))));
  addFinding(findings, "artifact_root", withDerivedStackName(identityFromRecord(artifactBundle as unknown as Record<string, unknown>)));
  addFinding(findings, "k8s_yaml", identityFromKubernetesManifest(validatedBundle.kubernetesManifest?.content));

  const derivedSource = requestIdentity
    ?? completeIdentity(identityFromRecord(validatedBundle.metadata))
    ?? completeIdentity(identityFromRecord(recordValue(artifactBundle.infra_details)))
    ?? completeIdentity(identityFromRecord(artifactBundle as unknown as Record<string, unknown>));
  if (derivedSource) {
    findings.push({
      source: "derived",
      identity: {
        ...derivedSource,
        stack_name: deriveStackName(derivedSource.app_name, derivedSource.environment)
      }
    });
  }

  return findings;
}

export function completeIdentity(identity: Partial<DeploymentIdentity> | undefined): DeploymentIdentity | undefined {
  if (!identity) return undefined;
  const appName = clean(identity.app_name);
  const clusterName = clean(identity.cluster_name);
  const namespace = clean(identity.namespace);
  const region = clean(identity.aws_region);
  const environment = clean(identity.environment) ?? inferEnvironment(clean(identity.stack_name), appName);
  const stackName = clean(identity.stack_name) ?? (appName && environment ? deriveStackName(appName, environment) : undefined);
  if (!appName || !stackName || !clusterName || !namespace || !region || !environment) return undefined;
  return {
    app_name: appName,
    stack_name: stackName,
    cluster_name: clusterName,
    namespace,
    aws_region: region,
    environment
  };
}

function addFinding(findings: IdentityFinding[], source: IdentitySource, identity: Partial<DeploymentIdentity>): void {
  if (Object.values(identity).some((value) => typeof value === "string" && value.trim() !== "")) findings.push({ source, identity });
}

function identityFromRecord(record: Record<string, unknown> | undefined): Partial<DeploymentIdentity> {
  if (!record) return {};
  return {
    app_name: stringValue(record.app_name, record.appName, record.AppName),
    stack_name: stringValue(record.stack_name, record.stackName, record.StackName, record.expected_stack_name),
    cluster_name: stringValue(record.cluster_name, record.clusterName, record.ClusterName),
    namespace: stringValue(record.namespace, record.Namespace),
    aws_region: stringValue(record.aws_region, record.region, record.awsRegion, record.AwsRegion),
    environment: stringValue(record.environment, record.env, record.Environment)
  };
}

function withDerivedStackName(identity: Partial<DeploymentIdentity>): Partial<DeploymentIdentity> {
  if (identity.stack_name || !identity.app_name || !identity.environment) return identity;
  return { ...identity, stack_name: deriveStackName(identity.app_name, identity.environment) };
}

function identityFromKubernetesManifest(content?: string): Partial<DeploymentIdentity> {
  if (!content) return {};
  const namespace = content.match(/\n\s*namespace:\s*([A-Za-z0-9_.-]+)/)?.[1];
  const app = content.match(/\n\s*app:\s*([A-Za-z0-9_.-]+)/)?.[1]
    ?? content.match(/kind:\s*Deployment[\s\S]*?metadata:\s*\n(?:\s+[A-Za-z0-9_.-]+:.*\n)*\s+name:\s*([A-Za-z0-9_.-]+)/)?.[1];
  return { app_name: app, namespace };
}

function inferEnvironment(stackName: string | undefined, appName: string | undefined): string | undefined {
  if (!stackName || !appName) return undefined;
  const prefix = `${sanitizeName(appName)}-`;
  const suffix = "-eks";
  if (!stackName.startsWith(prefix) || !stackName.endsWith(suffix)) return undefined;
  return stackName.slice(prefix.length, -suffix.length) || undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
