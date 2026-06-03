import { z } from "zod";

const MAX_ARTIFACT_BYTES = 256_000;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;
const ALLOWED_TYPES = new Set(["cloudformation_template", "kubernetes_manifest", "metadata", "documentation"]);
const ALLOWED_FILENAMES = new Set(["template.yaml", "template.yml", "k8s.yaml", "k8s.yml", "params.json", "README.md"]);

export const DeploymentArtifactSchema = z.object({
  type: z.enum(["cloudformation_template", "kubernetes_manifest", "metadata", "documentation"]),
  filename: z.string().min(1),
  content: z.string().min(1)
});

export const ArtifactBundleSchema = z.object({
  status: z.string(),
  deployment_plan: z.array(z.string()).optional(),
  deployment_artifacts: z.array(DeploymentArtifactSchema).optional(),
  infra_details: z.record(z.unknown()).optional(),
  estimated_monthly_cost_usd: z.union([z.number(), z.string()]).optional(),
  cost_notes: z.string().optional(),
  security_notes: z.string().optional(),
  next_steps: z.array(z.string()).optional()
});

export type DeploymentArtifact = z.infer<typeof DeploymentArtifactSchema>;
export type ArtifactBundle = z.infer<typeof ArtifactBundleSchema>;

export function parseArtifactBundle(value: unknown): ArtifactBundle | null {
  const payload = unwrapJson(value);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (!("deployment_artifacts" in payload)) return null;
  return ArtifactBundleSchema.parse(payload);
}

export function validateArtifactBundle(bundle: ArtifactBundle): ValidatedArtifactBundle {
  if (String(bundle.status).toLowerCase() !== "artifacts_ready") {
    throw new Error(`Bodhi artifact bundle is not ready for deployment. Status: ${bundle.status}`);
  }

  const artifacts = bundle.deployment_artifacts ?? [];
  if (artifacts.length === 0) {
    throw new Error("Bodhi artifact bundle did not include deployment_artifacts");
  }

  const validated = artifacts.map(validateArtifact);
  const cloudformationTemplate = validated.find((artifact) => artifact.type === "cloudformation_template");
  if (!cloudformationTemplate) {
    throw new Error("Bodhi artifact bundle must include a cloudformation_template artifact");
  }

  const kubernetesManifest = validated.find((artifact) => artifact.type === "kubernetes_manifest");
  const metadataArtifact = validated.find((artifact) => artifact.type === "metadata");
  const metadata = parseMetadata(metadataArtifact?.content);

  return {
    ...bundle,
    deployment_artifacts: validated,
    cloudformationTemplate,
    kubernetesManifest,
    metadata
  };
}

export type ValidatedArtifactBundle = ArtifactBundle & {
  deployment_artifacts: DeploymentArtifact[];
  cloudformationTemplate: DeploymentArtifact;
  kubernetesManifest?: DeploymentArtifact;
  metadata: Record<string, unknown>;
};

function validateArtifact(artifact: DeploymentArtifact): DeploymentArtifact {
  if (!ALLOWED_TYPES.has(artifact.type)) {
    throw new Error(`Unsupported artifact type: ${artifact.type}`);
  }

  if (!SAFE_FILENAME.test(artifact.filename) || artifact.filename.startsWith(".") || artifact.filename.includes("..")) {
    throw new Error(`Unsafe artifact filename: ${artifact.filename}`);
  }

  if (!ALLOWED_FILENAMES.has(artifact.filename)) {
    throw new Error(`Artifact filename is not allowed: ${artifact.filename}`);
  }

  if (Buffer.byteLength(artifact.content, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact ${artifact.filename} exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }

  return artifact;
}

function parseMetadata(content?: string): Record<string, unknown> {
  if (!content) return {};
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadata artifact must contain a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function unwrapJson(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const withoutFence = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "");
    return JSON.parse(withoutFence);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of ["result", "response", "output", "text"]) {
      if (key in object) {
        const parsed = tryUnwrapJson(object[key]);
        if (parsed) return parsed;
      }
    }
  }

  return value;
}

function tryUnwrapJson(value: unknown): unknown | null {
  try {
    return unwrapJson(value);
  } catch {
    return null;
  }
}
