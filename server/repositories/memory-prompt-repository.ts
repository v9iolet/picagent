import { samePromptTemplateContent, validatePromptTemplateContract, withPromptTemplateUsage, type PromptStage, type PromptTemplatePublic, type PromptTemplateRecord, type PromptTemplateRuntime, type PromptVersionStatus } from "../prompt-library.js";

interface TemplateIdentity {
  id: string;
  code: string;
  publishedVersionId: string | null;
}

export class MemoryPromptRepository {
  private readonly templates = new Map<string, TemplateIdentity>();
  private readonly versions = new Map<string, PromptTemplateRuntime>();

  async importRecords(records: PromptTemplateRecord[]): Promise<PromptTemplateRuntime[]> {
    for (const record of records) validatePromptTemplateContract(record);
    const imported: PromptTemplateRuntime[] = [];
    for (const record of records) {
      let template = [...this.templates.values()].find(({ code }) => code === record.code);
      if (!template) {
        template = { id: record.templateId, code: record.code, publishedVersionId: null };
        this.templates.set(template.id, template);
      }
      const existing = [...this.versions.values()].find((version) => version.templateId === template.id && version.sourceSha256 === record.sourceSha256 && version.sourceHeading === record.sourceHeading);
      if (existing) {
        if (existing.status === "draft") Object.assign(existing, {
          name: record.name,
          kind: record.kind,
          stage: record.stage,
          executionTarget: record.executionTarget,
          inputSchema: record.inputSchema,
          outputSchema: record.outputSchema,
          applicability: record.applicability,
          body: record.body,
          userPromptTemplate: record.userPromptTemplate ?? "",
          sourceFile: record.sourceFile,
        });
        imported.push(existing);
        continue;
      }
      const sameContentCandidates = [...this.versions.values()].filter(
        (version) => version.templateId === template!.id && version.status !== "retired" && samePromptTemplateContent(version, record),
      );
      const sameContent =
        sameContentCandidates.find((version) => version.status === "published") ??
        sameContentCandidates.sort((a, b) => b.versionNo - a.versionNo)[0];
      if (sameContent) {
        imported.push(sameContent);
        continue;
      }
      const versionNo = Math.max(0, ...[...this.versions.values()].filter((version) => version.templateId === template!.id).map((version) => version.versionNo)) + 1;
      const version: PromptTemplateRuntime = {
        templateId: template.id,
        templateVersionId: record.templateVersionId,
        versionNo,
        code: template.code,
        name: record.name,
        kind: record.kind,
        stage: record.stage,
        executionTarget: record.executionTarget,
        inputSchema: record.inputSchema,
        outputSchema: record.outputSchema,
        applicability: record.applicability,
        body: record.body,
        userPromptTemplate: record.userPromptTemplate ?? "",
        status: "draft",
        sourceFile: record.sourceFile,
        sourceHeading: record.sourceHeading,
        sourceSha256: record.sourceSha256,
      };
      this.versions.set(version.templateVersionId, version);
      imported.push(withPromptTemplateUsage(version));
    }
    return imported;
  }

  async publishVersion(versionId: string): Promise<PromptTemplateRuntime | null> {
    const version = this.versions.get(versionId);
    if (!version) return null;
    validatePromptTemplateContract(version);
    const template = this.templates.get(version.templateId)!;
    if (template.publishedVersionId && template.publishedVersionId !== versionId) {
      const current = this.versions.get(template.publishedVersionId);
      if (current) current.status = "retired";
    }
    version.status = "published";
    template.publishedVersionId = versionId;
    return withPromptTemplateUsage(version);
  }

  private toPublic(version: PromptTemplateRuntime): PromptTemplatePublic {
    const {
      body: _body,
      userPromptTemplate: _userPromptTemplate,
      outputSchema: _outputSchema,
      sourceFile: _sourceFile,
      sourceHeading: _sourceHeading,
      sourceSha256: _sourceSha256,
      ...publicVersion
    } = version;
    return withPromptTemplateUsage(publicVersion);
  }

  async listPublished(stage?: PromptStage): Promise<PromptTemplatePublic[]> {
    return [...this.templates.values()]
      .filter((template) => template.publishedVersionId)
      .map((template) => this.versions.get(template.publishedVersionId!)!)
      .filter((version) => version.status === "published" && (!stage || version.stage === stage))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((version) => this.toPublic(version));
  }

  async listTemplates(options: { stage?: PromptStage; status?: PromptVersionStatus | "all" } = {}): Promise<PromptTemplatePublic[]> {
    const status = options.status ?? "published";
    if (status === "published") return this.listPublished(options.stage);
    const rank = (template: TemplateIdentity, version: PromptTemplateRuntime) => {
      if (version.templateVersionId === template.publishedVersionId && version.status === "published") return 0;
      if (version.status === "published") return 1;
      if (version.status === "draft") return 2;
      return 3;
    };
    const representatives: PromptTemplateRuntime[] = [];
    for (const template of this.templates.values()) {
      const candidates = [...this.versions.values()]
        .filter((version) => version.templateId === template.id && (!options.stage || version.stage === options.stage))
        .sort((a, b) => rank(template, a) - rank(template, b) || b.versionNo - a.versionNo);
      if (candidates[0]) representatives.push(candidates[0]);
    }
    return representatives
      .filter((version) => status === "all" || version.status === status)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((version) => this.toPublic(version));
  }

  async getPublishedVersion(versionId: string, expectedStage?: PromptStage): Promise<PromptTemplateRuntime | null> {
    const version = this.versions.get(versionId);
    const template = version ? this.templates.get(version.templateId) : undefined;
    return version && template?.publishedVersionId === versionId && version.status === "published" && (!expectedStage || version.stage === expectedStage)
      ? withPromptTemplateUsage(version)
      : null;
  }

  async listVersions(templateId: string): Promise<PromptTemplateRuntime[]> {
    return [...this.versions.values()]
      .filter((version) => version.templateId === templateId)
      .sort((a, b) => a.versionNo - b.versionNo)
      .map((version) => withPromptTemplateUsage(version));
  }

  async getVersion(versionId: string): Promise<PromptTemplateRuntime | null> {
    const version = this.versions.get(versionId);
    return version ? withPromptTemplateUsage(version) : null;
  }

  async updateDraft(versionId: string, patch: Partial<Pick<PromptTemplateRuntime, "name" | "body" | "userPromptTemplate" | "inputSchema" | "outputSchema" | "applicability">>): Promise<PromptTemplateRuntime | null> {
    const version = this.versions.get(versionId);
    if (!version || version.status !== "draft") return null;
    Object.assign(version, patch);
    return withPromptTemplateUsage(version);
  }

  async copyVersion(versionId: string): Promise<PromptTemplateRuntime | null> {
    const source = this.versions.get(versionId);
    if (!source) return null;
    const nextVersion = Math.max(0, ...[...this.versions.values()].filter((version) => version.templateId === source.templateId).map((version) => version.versionNo)) + 1;
    const copy: PromptTemplateRuntime = { ...source, templateVersionId: `${source.templateVersionId}-v${nextVersion}`, versionNo: nextVersion, status: "draft", sourceFile: "manual", sourceHeading: source.name, sourceSha256: `${source.sourceSha256}:${nextVersion}` };
    this.versions.set(copy.templateVersionId, copy);
    return withPromptTemplateUsage(copy);
  }

  async retireVersion(versionId: string): Promise<PromptTemplateRuntime | null> {
    const version = this.versions.get(versionId);
    if (!version) return null;
    version.status = "retired";
    const template = this.templates.get(version.templateId);
    if (template?.publishedVersionId === versionId) template.publishedVersionId = null;
    return withPromptTemplateUsage(version);
  }
}
